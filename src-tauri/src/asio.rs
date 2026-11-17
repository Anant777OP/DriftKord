//! Native ASIO host — talks to installed ASIO drivers directly (they're COM objects listed under
//! HKLM\SOFTWARE\ASIO), so no Steinberg SDK is needed to build it and every build includes it.
//!
//! ASIO drivers talk straight to the DAC, bypassing the Windows audio engine entirely. If the
//! driver accepts the source rate we switch to it (bit-perfect, DoP included for DSD); otherwise
//! we keep the driver's current rate and the player's resampler converts.

use crate::audio::{pull_frames, should_stop, OutputConfig, OutputState, RunEnd, Shared};
use parking_lot::Mutex;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use windows::core::GUID;

// ---------------------------------------------------------------------------------------------
// Driver discovery
// ---------------------------------------------------------------------------------------------

fn drivers() -> Vec<(String, GUID)> {
    let mut v = Vec::new();
    let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
    for root in ["SOFTWARE\\ASIO", "SOFTWARE\\WOW6432Node\\ASIO"] {
        let Ok(k) = hklm.open_subkey(root) else { continue };
        for name in k.enum_keys().flatten() {
            let Ok(sub) = k.open_subkey(&name) else { continue };
            let Ok(clsid) = sub.get_value::<String, _>("CLSID") else { continue };
            let s = clsid.trim().trim_start_matches('{').trim_end_matches('}');
            if let Ok(u) = u128::from_str_radix(&s.replace('-', ""), 16) {
                if !v.iter().any(|(n, _)| n == &name) {
                    v.push((name, GUID::from_u128(u)));
                }
            }
        }
        // 32-bit-only drivers under WOW6432Node can't load into this 64-bit app
        break;
    }
    v
}

pub fn list_asio() -> Result<Vec<String>, String> {
    Ok(drivers().into_iter().map(|(n, _)| n).collect())
}

// ---------------------------------------------------------------------------------------------
// IASIO (x64: the C++ vtable uses the normal Windows x64 calling convention)
// ---------------------------------------------------------------------------------------------

#[repr(C)]
struct Vtbl {
    query_interface: usize,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    init: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32,
    get_driver_name: unsafe extern "system" fn(*mut c_void, *mut u8),
    get_driver_version: unsafe extern "system" fn(*mut c_void) -> i32,
    get_error_message: unsafe extern "system" fn(*mut c_void, *mut u8),
    start: unsafe extern "system" fn(*mut c_void) -> i32,
    stop: unsafe extern "system" fn(*mut c_void) -> i32,
    get_channels: unsafe extern "system" fn(*mut c_void, *mut i32, *mut i32) -> i32,
    get_latencies: unsafe extern "system" fn(*mut c_void, *mut i32, *mut i32) -> i32,
    get_buffer_size: unsafe extern "system" fn(*mut c_void, *mut i32, *mut i32, *mut i32, *mut i32) -> i32,
    can_sample_rate: unsafe extern "system" fn(*mut c_void, f64) -> i32,
    get_sample_rate: unsafe extern "system" fn(*mut c_void, *mut f64) -> i32,
    set_sample_rate: unsafe extern "system" fn(*mut c_void, f64) -> i32,
    get_clock_sources: usize,
    set_clock_source: usize,
    get_sample_position: usize,
    get_channel_info: unsafe extern "system" fn(*mut c_void, *mut ChannelInfo) -> i32,
    create_buffers: unsafe extern "system" fn(*mut c_void, *mut BufferInfo, i32, i32, *const Callbacks) -> i32,
    dispose_buffers: unsafe extern "system" fn(*mut c_void) -> i32,
    control_panel: unsafe extern "system" fn(*mut c_void) -> i32,
    future: unsafe extern "system" fn(*mut c_void, i32, *mut c_void) -> i32,
    output_ready: unsafe extern "system" fn(*mut c_void) -> i32,
}

#[repr(C)]
struct ChannelInfo {
    channel: i32,
    is_input: i32,
    is_active: i32,
    group: i32,
    kind: i32,
    name: [u8; 32],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct BufferInfo {
    is_input: i32,
    channel: i32,
    buffers: [*mut c_void; 2],
}

#[repr(C)]
struct Callbacks {
    buffer_switch: extern "C" fn(i32, i32),
    sample_rate_changed: extern "C" fn(f64),
    message: extern "C" fn(i32, i32, *mut c_void, *mut f64) -> i32,
    buffer_switch_time_info: extern "C" fn(*mut c_void, i32, i32) -> *mut c_void,
}

const ASE_OK: i32 = 0;
const ASE_SUCCESS: i32 = 0x3f48_47a0;
fn ok(e: i32) -> bool {
    e == ASE_OK || e == ASE_SUCCESS
}

struct Driver(*mut c_void);
unsafe impl Send for Driver {}
impl Driver {
    fn vt(&self) -> &Vtbl {
        unsafe { &**(self.0 as *mut *const Vtbl) }
    }
    fn error(&self) -> String {
        let mut b = [0u8; 128];
        unsafe { (self.vt().get_error_message)(self.0, b.as_mut_ptr()) };
        let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
        String::from_utf8_lossy(&b[..end]).to_string()
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        unsafe { (self.vt().release)(self.0) };
    }
}

#[link(name = "ole32")]
extern "system" {
    fn CoCreateInstance(rclsid: *const GUID, outer: *mut c_void, ctx: u32, riid: *const GUID, ppv: *mut *mut c_void) -> i32;
    fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> i32;
    fn CoUninitialize();
}

// ---------------------------------------------------------------------------------------------
// Callback context (ASIO allows one active driver per process)
// ---------------------------------------------------------------------------------------------

struct Ctx {
    sh: Arc<Shared>,
    drv: *mut c_void,
    bufs: Vec<[*mut c_void; 2]>,
    size: usize,
    kind: i32,
    tmp: Vec<f32>,
    output_ready: bool,
}
unsafe impl Send for Ctx {}

static CTX: Mutex<Option<Ctx>> = Mutex::new(None);
static RESET: AtomicBool = AtomicBool::new(false);

fn write_samples(kind: i32, dst: *mut c_void, src: &[f32], ch: usize, stride: usize, n: usize) {
    unsafe {
        let s = |i: usize| src[i * stride + ch] as f64;
        match kind {
            16 => {
                let d = std::slice::from_raw_parts_mut(dst as *mut i16, n);
                for (i, v) in d.iter_mut().enumerate() {
                    *v = (s(i) * 32_768.0).round().clamp(-32_768.0, 32_767.0) as i16;
                }
            }
            17 => {
                let d = std::slice::from_raw_parts_mut(dst as *mut u8, n * 3);
                for i in 0..n {
                    let v = (s(i) * 8_388_608.0).round().clamp(-8_388_608.0, 8_388_607.0) as i32;
                    d[i * 3..i * 3 + 3].copy_from_slice(&v.to_le_bytes()[0..3]);
                }
            }
            19 => {
                let d = std::slice::from_raw_parts_mut(dst as *mut f32, n);
                for (i, v) in d.iter_mut().enumerate() {
                    *v = s(i) as f32;
                }
            }
            20 => {
                let d = std::slice::from_raw_parts_mut(dst as *mut f64, n);
                for (i, v) in d.iter_mut().enumerate() {
                    *v = s(i);
                }
            }
            // 32-bit containers: 18 = full 32 bit; 24..27 = 16/18/20/24 bits right-aligned
            _ => {
                let bits = match kind {
                    24 => 16,
                    25 => 18,
                    26 => 20,
                    27 => 24,
                    _ => 32,
                };
                let scale = (1u64 << (bits - 1)) as f64;
                let d = std::slice::from_raw_parts_mut(dst as *mut i32, n);
                for (i, v) in d.iter_mut().enumerate() {
                    *v = (s(i) * scale).round().clamp(-scale, scale - 1.0) as i32;
                }
            }
        }
    }
}

extern "C" fn on_buffer_switch(index: i32, _direct: i32) {
    let mut g = CTX.lock();
    let Some(c) = g.as_mut() else { return };
    let idx = (index & 1) as usize;
    let mut tmp = std::mem::take(&mut c.tmp);
    pull_frames(&c.sh, &mut tmp, c.size);
    for (ch, b) in c.bufs.iter().enumerate() {
        write_samples(c.kind, b[idx], &tmp, ch.min(1), 2, c.size);
    }
    c.tmp = tmp;
    if c.output_ready {
        unsafe { ((*(*(c.drv as *mut *const Vtbl))).output_ready)(c.drv) };
    }
}
extern "C" fn on_rate_changed(_rate: f64) {
    RESET.store(true, Ordering::SeqCst);
}
extern "C" fn on_message(selector: i32, value: i32, _msg: *mut c_void, _opt: *mut f64) -> i32 {
    match selector {
        1 => matches!(value, 1 | 2 | 3 | 4 | 5 | 6) as i32, // selector supported?
        2 => 2,                                             // host ASIO version
        3 | 4 => {
            RESET.store(true, Ordering::SeqCst); // reset request / buffer size change
            1
        }
        5 | 6 => 1, // resync / latencies changed
        _ => 0,
    }
}
extern "C" fn on_buffer_switch_time_info(params: *mut c_void, index: i32, direct: i32) -> *mut c_void {
    on_buffer_switch(index, direct);
    params
}

static CALLBACKS: Callbacks = Callbacks {
    buffer_switch: on_buffer_switch,
    sample_rate_changed: on_rate_changed,
    message: on_message,
    buffer_switch_time_info: on_buffer_switch_time_info,
};

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

pub fn run_asio(sh: &Arc<Shared>, cfg: &OutputConfig, rate: u32, gen: u64) -> Result<RunEnd, String> {
    // ASIO drivers expect a single-threaded COM apartment; the output thread is MTA, so host the
    // driver on its own thread for the whole session.
    let (sh2, cfg2) = (sh.clone(), cfg.clone());
    let t = std::thread::Builder::new()
        .name("asio".into())
        .spawn(move || unsafe {
            CoInitializeEx(std::ptr::null_mut(), 0x2 /* APARTMENTTHREADED */);
            let r = session(&sh2, &cfg2, rate, gen);
            CoUninitialize();
            r
        })
        .map_err(|e| e.to_string())?;
    t.join().map_err(|_| "ASIO driver crashed".to_string())?
}

fn session(sh: &Arc<Shared>, cfg: &OutputConfig, rate: u32, gen: u64) -> Result<RunEnd, String> {
    let list = drivers();
    if list.is_empty() {
        return Err("No ASIO driver is installed (install your DAC's ASIO driver, or use WASAPI Exclusive).".into());
    }
    let (name, clsid) = match cfg.asio_device.as_deref() {
        Some(n) if !n.is_empty() => list.iter().find(|(d, _)| d == n).cloned().ok_or_else(|| format!("ASIO driver '{n}' not found"))?,
        _ => list[0].clone(),
    };
    let drv = unsafe {
        let mut p: *mut c_void = std::ptr::null_mut();
        // ASIO drivers use their CLSID as the interface id
        let hr = CoCreateInstance(&clsid, std::ptr::null_mut(), 1 /* INPROC_SERVER */, &clsid, &mut p);
        if hr < 0 || p.is_null() {
            return Err(format!("Couldn't load the ASIO driver '{name}' (0x{hr:08X})"));
        }
        Driver(p)
    };
    let vt = drv.vt();
    unsafe {
        if (vt.init)(drv.0, std::ptr::null_mut()) == 0 {
            return Err(format!("ASIO driver '{name}' failed to start: {}", drv.error()));
        }
        let (mut ins, mut outs) = (0i32, 0i32);
        (vt.get_channels)(drv.0, &mut ins, &mut outs);
        if outs < 1 {
            return Err("ASIO driver has no outputs".into());
        }
        // rate: the source's if the driver can do it (bit-perfect), else whatever it runs at
        let src_dop = sh.player.lock().cur.as_ref().map(|c| c.info.dop).unwrap_or(false);
        let mut out_rate = rate as f64;
        let supports = ok((vt.can_sample_rate)(drv.0, out_rate));
        if supports {
            (vt.set_sample_rate)(drv.0, out_rate);
        } else {
            (vt.get_sample_rate)(drv.0, &mut out_rate);
        }
        let (mut min, mut max, mut pref, mut gran) = (0i32, 0i32, 0i32, 0i32);
        (vt.get_buffer_size)(drv.0, &mut min, &mut max, &mut pref, &mut gran);
        let size = pref.max(min).max(64);
        let nch = outs.min(2) as usize;
        let mut info = ChannelInfo { channel: 0, is_input: 0, is_active: 0, group: 0, kind: 18, name: [0; 32] };
        (vt.get_channel_info)(drv.0, &mut info);
        let kind = info.kind;
        let mut bi: Vec<BufferInfo> = (0..nch).map(|c| BufferInfo { is_input: 0, channel: c as i32, buffers: [std::ptr::null_mut(); 2] }).collect();
        let e = (vt.create_buffers)(drv.0, bi.as_mut_ptr(), nch as i32, size, &CALLBACKS);
        if !ok(e) {
            return Err(format!("ASIO: couldn't create buffers ({})", drv.error()));
        }
        let int_fmt = !matches!(kind, 19 | 20);
        let dop_ok = src_dop && supports && int_fmt && matches!(kind, 17 | 18 | 27);
        sh.player.lock().output_opened(out_rate as u32, true, dop_ok);
        let output_ready = ok((vt.output_ready)(drv.0));
        RESET.store(false, Ordering::SeqCst);
        *CTX.lock() = Some(Ctx {
            sh: sh.clone(),
            drv: drv.0,
            bufs: bi.iter().map(|b| b.buffers).collect(),
            size: size as usize,
            kind,
            tmp: Vec::with_capacity(size as usize * 2),
            output_ready,
        });
        // silence both halves before starting
        for b in bi.iter() {
            for half in b.buffers {
                write_samples(kind, half, &vec![0.0; size as usize * 2], 0, 2, size as usize);
            }
        }
        if !ok((vt.start)(drv.0)) {
            CTX.lock().take();
            (vt.dispose_buffers)(drv.0);
            return Err(format!("ASIO: start failed ({})", drv.error()));
        }
        let bits = match kind {
            16 | 24 => 16,
            17 | 27 => 24,
            25 => 18,
            26 => 20,
            _ => 32,
        };
        *sh.out_state.lock() = OutputState {
            open: true,
            backend: "ASIO".into(),
            exclusive: true,
            rate: out_rate as u32,
            bits,
            container_bits: match kind { 16 => 16, 17 => 24, 20 => 64, _ => 32 },
            float: matches!(kind, 19 | 20),
            device_name: name.clone(),
            error: if supports { None } else { Some(format!("Driver locked at {} Hz — resampling", out_rate as u32)) },
            fell_back: false,
        };
        let end = loop {
            if let Some(e) = should_stop(sh, gen) {
                break e;
            }
            if RESET.swap(false, Ordering::SeqCst) {
                break RunEnd::Reopen;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        (vt.stop)(drv.0);
        CTX.lock().take();
        (vt.dispose_buffers)(drv.0);
        sh.out_state.lock().open = false;
        Ok(end)
    }
}

/// Open the driver's own settings window.
pub fn control_panel(name: &str) -> Result<(), String> {
    let list = drivers();
    let (_, clsid) = list.iter().find(|(d, _)| d == name).cloned().ok_or("ASIO driver not found")?;
    let name = name.to_string();
    std::thread::spawn(move || unsafe {
        CoInitializeEx(std::ptr::null_mut(), 0x2);
        let mut p: *mut c_void = std::ptr::null_mut();
        if CoCreateInstance(&clsid, std::ptr::null_mut(), 1, &clsid, &mut p) >= 0 && !p.is_null() {
            let d = Driver(p);
            if (d.vt().init)(d.0, std::ptr::null_mut()) != 0 {
                (d.vt().control_panel)(d.0);
            }
        }
        let _ = name;
        CoUninitialize();
    });
    Ok(())
}

//! Artist biographies: MusicBrainz identifies the artist (type, origin, active years, genres and
//! the link to its Wikipedia article via Wikidata); Wikipedia supplies the photo, the one-line
//! description and the biography text (CC BY-SA, credited in the UI). Results are cached.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtistBio {
    pub name: String,
    pub found: bool,
    /// "Person" | "Group" | "Orchestra" | "Choir" | …
    pub kind: String,
    pub description: String,
    pub origin: String,
    pub active: String,
    pub genres: Vec<String>,
    pub image: Option<String>,
    pub summary: String,
    pub sections: Vec<Section>,
    pub wikipedia_url: Option<String>,
    pub musicbrainz_url: Option<String>,
    pub fetched_at: i64,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .user_agent("DriftKord/1.0 (open-source music player)")
        .build()
}

fn get_json(url: &str) -> Option<Value> {
    agent().get(url).set("Accept", "application/json").call().ok()?.into_json().ok()
}

/// MusicBrainz allows about one request per second per client: space every request out, and
/// retry once if it says it's busy.
fn mb_json(url: &str) -> Option<Value> {
    static LAST: parking_lot::Mutex<Option<std::time::Instant>> = parking_lot::Mutex::new(None);
    for attempt in 0..2 {
        {
            let mut last = LAST.lock();
            if let Some(t) = *last {
                let wait = Duration::from_millis(1100).saturating_sub(t.elapsed());
                std::thread::sleep(wait);
            }
            *last = Some(std::time::Instant::now());
        }
        match agent().get(url).set("Accept", "application/json").call() {
            Ok(r) => return r.into_json().ok(),
            Err(_) if attempt == 0 => std::thread::sleep(Duration::from_millis(2000)),
            Err(_) => return None,
        }
    }
    None
}

fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

fn norm(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// "Artist A, Artist B & C feat. D" -> "Artist A"
pub fn primary_artist(a: &str) -> String {
    let lower = a.to_lowercase();
    let mut cut = a.len();
    for sep in [" feat.", " feat ", " ft.", " ft ", " featuring ", " x ", " & ", ", ", " and ", " / ", "; "] {
        if let Some(i) = lower.find(sep) {
            cut = cut.min(i);
        }
    }
    a[..cut].trim().to_string()
}

const MUSIC_WORDS: [&str; 14] = ["singer", "band", "musician", "rapper", "composer", "songwriter", "duo", "group", "dj", "producer", "music", "vocalist", "orchestra", "guitarist"];

/// MusicBrainz: best matching artist -> (fields, wikipedia title if linked)
fn musicbrainz(name: &str, bio: &mut ArtistBio) -> Option<String> {
    let q = format!("https://musicbrainz.org/ws/2/artist?query={}&limit=5&fmt=json", enc(&format!("artist:\"{name}\"")));
    let res = mb_json(&q)?;
    let target = norm(name);
    let artists = res["artists"].as_array()?;
    let best = artists
        .iter()
        .filter(|a| a["score"].as_i64().unwrap_or(0) >= 85)
        .find(|a| norm(a["name"].as_str().unwrap_or("")) == target || a["aliases"].as_array().map(|al| al.iter().any(|x| norm(x["name"].as_str().unwrap_or("")) == target)).unwrap_or(false))
        .or_else(|| artists.first().filter(|a| a["score"].as_i64().unwrap_or(0) >= 95))?;
    let id = best["id"].as_str()?.to_string();
    let full = mb_json(&format!("https://musicbrainz.org/ws/2/artist/{id}?inc=url-rels+genres+tags&fmt=json")).unwrap_or_else(|| best.clone());
    bio.found = true;
    bio.name = full["name"].as_str().unwrap_or(name).to_string();
    bio.kind = full["type"].as_str().unwrap_or("").to_string();
    let area = full["area"]["name"].as_str().unwrap_or("");
    let begin_area = full["begin-area"]["name"].as_str().unwrap_or("");
    bio.origin = match (begin_area.is_empty(), area.is_empty()) {
        (false, false) if begin_area != area => format!("{begin_area}, {area}"),
        (false, _) => begin_area.to_string(),
        (true, false) => area.to_string(),
        _ => String::new(),
    };
    let begin = full["life-span"]["begin"].as_str().unwrap_or("").get(0..4).unwrap_or("").to_string();
    let end = full["life-span"]["end"].as_str().unwrap_or("").get(0..4).unwrap_or("").to_string();
    let ended = full["life-span"]["ended"].as_bool().unwrap_or(false);
    let person = bio.kind == "Person";
    bio.active = match (begin.is_empty(), end.is_empty(), ended) {
        (false, true, false) => if person { format!("Born {begin}") } else { format!("Since {begin}") },
        (false, false, _) => if person { format!("{begin} – {end}") } else { format!("{begin} – {end}") },
        _ => String::new(),
    };
    let mut genres: Vec<(i64, String)> = full["genres"]
        .as_array()
        .or_else(|| full["tags"].as_array())
        .map(|g| g.iter().map(|x| (x["count"].as_i64().unwrap_or(0), x["name"].as_str().unwrap_or("").to_string())).filter(|(_, n)| !n.is_empty()).collect())
        .unwrap_or_default();
    genres.sort_by(|a, b| b.0.cmp(&a.0));
    bio.genres = genres.into_iter().take(5).map(|(_, n)| n).collect();
    if bio.description.is_empty() {
        bio.description = full["disambiguation"].as_str().unwrap_or("").to_string();
    }
    bio.musicbrainz_url = Some(format!("https://musicbrainz.org/artist/{id}"));
    // Wikipedia: direct link, or through Wikidata
    let rels = full["relations"].as_array().cloned().unwrap_or_default();
    for r in &rels {
        if r["type"] == "wikipedia" {
            if let Some(u) = r["url"]["resource"].as_str() {
                if let Some(t) = u.split("en.wikipedia.org/wiki/").nth(1) {
                    return Some(t.replace('_', " "));
                }
            }
        }
    }
    for r in &rels {
        if r["type"] == "wikidata" {
            let q = r["url"]["resource"].as_str()?.rsplit('/').next()?.to_string();
            let wd = get_json(&format!("https://www.wikidata.org/w/api.php?action=wbgetentities&ids={q}&props=sitelinks&sitefilter=enwiki&format=json"))?;
            return wd["entities"][&q]["sitelinks"]["enwiki"]["title"].as_str().map(|s| s.to_string());
        }
    }
    None
}

/// The likely article names for a musician, tried in order; the first one that is clearly about
/// music wins ("Queen" is the monarch, "Queen (band)" is the band).
fn wikipedia_direct(name: &str) -> Option<String> {
    for suffix in ["", " (band)", " (musician)", " (singer)", " (composer)", " (rapper)", " (group)", " (duo)"] {
        let title = format!("{name}{suffix}");
        let Some(s) = get_json(&format!("https://en.wikipedia.org/api/rest_v1/page/summary/{}", enc(&title.replace(' ', "_")))) else { continue };
        if s["type"] != "standard" {
            continue;
        }
        let about = format!("{} {}", s["description"].as_str().unwrap_or(""), s["extract"].as_str().unwrap_or("").chars().take(300).collect::<String>()).to_lowercase();
        if MUSIC_WORDS.iter().any(|w| about.contains(w)) {
            return Some(s["title"].as_str().unwrap_or(&title).to_string());
        }
    }
    None
}

/// Wikipedia full-text search fallback, keeping only music-related articles.
fn wikipedia_search(name: &str) -> Option<String> {
    let url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={}&srlimit=5&format=json",
        enc(&format!("{name} singer OR band OR musician OR rapper OR composer"))
    );
    let res = get_json(&url)?;
    let target = norm(name);
    res["query"]["search"].as_array()?.iter().find_map(|h| {
        let title = h["title"].as_str()?;
        let snip = h["snippet"].as_str().unwrap_or("").to_lowercase();
        let t = norm(title.split(" (").next().unwrap_or(title));
        (t == target && MUSIC_WORDS.iter().any(|w| snip.contains(w))).then(|| title.to_string())
    })
}

/// Download an image (a 500px rendition, else the size Wikipedia offered) and return it as a data: URL.
fn photo(url: &str) -> Option<String> {
    let original = url;
    use base64::Engine as _;
    // thumbnails look like …/thumb/a/ab/File.jpg/330px-File.jpg — ask for 500px (Wikimedia only serves standard sizes)
    let url = match url.rsplit_once('/') {
        Some((dir, file)) if url.contains("/thumb/") => match file.split_once("px-") {
            Some((_, rest)) => format!("{dir}/500px-{rest}"),
            None => url.to_string(),
        },
        _ => url.to_string(),
    };
    let r = match agent().get(&url).call() {
        Ok(r) => r,
        Err(_) => agent().get(original).call().ok()?,
    };
    let mime = r.content_type().to_string();
    if !mime.starts_with("image/") {
        return None;
    }
    let mut bytes = Vec::new();
    use std::io::Read;
    r.into_reader().take(3 << 20).read_to_end(&mut bytes).ok()?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

fn wikipedia(title: &str, bio: &mut ArtistBio) -> bool {
    let t = enc(&title.replace(' ', "_"));
    if let Some(s) = get_json(&format!("https://en.wikipedia.org/api/rest_v1/page/summary/{t}")) {
        if s["type"] == "disambiguation" {
            return false;
        }
        if let Some(d) = s["description"].as_str() {
            bio.description = d.to_string();
        }
        bio.summary = s["extract"].as_str().unwrap_or("").to_string();
        // a small copy of the photo, stored with the biography (works offline; Wikimedia may refuse
        // to serve images straight into the app)
        let src = s["thumbnail"]["source"].as_str().or_else(|| s["originalimage"]["source"].as_str()).map(|x| x.to_string());
        bio.image = src.and_then(|u| photo(&u));
        bio.wikipedia_url = s["content_urls"]["desktop"]["page"].as_str().map(|x| x.to_string());
        if bio.name.is_empty() {
            bio.name = s["title"].as_str().unwrap_or(title).to_string();
        }
    }
    // the article body, split into sections (plain text)
    let url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&format=json&titles={}",
        enc(title)
    );
    if let Some(r) = get_json(&url) {
        if let Some(pages) = r["query"]["pages"].as_object() {
            if let Some(p) = pages.values().next() {
                let text = p["extract"].as_str().unwrap_or("");
                let mut cur = Section { title: "Overview".into(), text: String::new() };
                let skip = ["discography", "filmography", "references", "external links", "see also", "notes", "awards and nominations", "tours", "bibliography", "further reading", "concert tours", "videography"];
                let mut keep = true;
                for line in text.lines() {
                    let l = line.trim();
                    if l.starts_with("==") && l.ends_with("==") {
                        let level = l.chars().take_while(|c| *c == '=').count();
                        let name = l.trim_matches('=').trim().to_string();
                        if level == 2 {
                            if keep && !cur.text.trim().is_empty() {
                                bio.sections.push(std::mem::take(&mut cur));
                            }
                            keep = !skip.iter().any(|s| name.to_lowercase().starts_with(s));
                            cur = Section { title: name, text: String::new() };
                        } else if keep && !name.is_empty() {
                            cur.text.push_str(&format!("\n§{name}\n"));
                        }
                        continue;
                    }
                    if keep && !l.is_empty() {
                        cur.text.push_str(l);
                        cur.text.push('\n');
                    }
                }
                if keep && !cur.text.trim().is_empty() {
                    bio.sections.push(cur);
                }
                // the article's introduction becomes the summary when it says more than the short one
                if bio.sections.first().map(|s| s.title == "Overview").unwrap_or(false) {
                    let lead = bio.sections.remove(0).text.trim().to_string();
                    if lead.len() > bio.summary.len() {
                        bio.summary = lead;
                    }
                }
                // keep it readable: long sections are shortened at a paragraph break, ~16,000 chars total
                let mut budget: usize = 16_000;
                let mut kept = Vec::new();
                for mut s in std::mem::take(&mut bio.sections) {
                    if budget < 400 {
                        break;
                    }
                    let cap = budget.min(4_000);
                    if s.text.len() > cap {
                        let mut cut = 0;
                        for (i, _) in s.text.match_indices('\n') {
                            if i > cap {
                                break;
                            }
                            cut = i;
                        }
                        if cut == 0 {
                            cut = s.text.char_indices().map(|(i, _)| i).take_while(|&i| i <= cap).last().unwrap_or(0);
                        }
                        s.text.truncate(cut);
                        s.text.push_str("\n…");
                    }
                    budget = budget.saturating_sub(s.text.len());
                    kept.push(s);
                }
                bio.sections = kept;
            }
        }
    }
    !bio.summary.is_empty()
}

pub fn lookup(artist: &str) -> ArtistBio {
    let name = primary_artist(artist);
    let mut bio = ArtistBio { name: name.clone(), ..Default::default() };
    if name.is_empty() {
        return bio;
    }
    // MusicBrainz knows exactly which article belongs to the artist; if it's busy or doesn't know,
    // find the article on Wikipedia directly
    let wiki_title = musicbrainz(&name, &mut bio).or_else(|| wikipedia_direct(&name)).or_else(|| wikipedia_search(&name));
    if let Some(t) = wiki_title {
        if wikipedia(&t, &mut bio) {
            bio.found = true;
        }
    }
    bio.fetched_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    bio
}

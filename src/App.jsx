import { useState, useEffect, useRef } from "react";

// ─── Supabase Storage ─────────────────────────────────────────────────────────
const SUPABASE_URL = "https://dbttxdswudslaapjzpit.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRidHR4ZHN3dWRzbGFhcGp6cGl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MjAxODUsImV4cCI6MjA5MTQ5NjE4NX0.HxYXen7x98U6mrW2CEUnQTzaN2SQNXPJ1nJn2cXMCi8";

// Map storage keys to table names
const TABLE_MAP = {
  "bq_events_v5":  "events",
  "bq_courses_v1": "courses",
  "bq_users_v1":   "users",
};

const SK_EVENTS  = "bq_events_v5";
const SK_COURSES = "bq_courses_v1";
const SK_USERS   = "bq_users_v1";

const sbFetch = async (path, opts = {}) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      ...( opts.headers || {} ),
    }
  });
  return r;
};

// Load all rows from a table, returns array merged into single object by key
const load = async (key) => {
  try {
    const table = TABLE_MAP[key];
    if (!table) return null;
    const r = await sbFetch(`${table}?select=id,data`);
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows || rows.length === 0) return null;
    // Return the data array (all items stored as individual rows)
    return rows.map(row => row.data);
  } catch { return null; }
};

const save = async (key, items) => {
  try {
    const table = TABLE_MAP[key];
    if (!table) return;
    if (!Array.isArray(items)) return;

    // Get existing IDs
    const r = await sbFetch(`${table}?select=id`);
    const existing = r.ok ? await r.json() : [];
    const existingIds = new Set(existing.map(e => e.id));

    const newIds = new Set(items.map(i => i.id));

    // Delete removed items
    const toDelete = [...existingIds].filter(id => !newIds.has(id));
    for (const id of toDelete) {
      await sbFetch(`${table}?id=eq.${id}`, { method: "DELETE" });
    }

    // Upsert all current items
    if (items.length > 0) {
      await sbFetch(table, {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify(items.map(item => ({ id: item.id, data: item })))
      });
    }
  } catch (e) { console.error("save error", e); }
};

// ─── Constants ────────────────────────────────────────────────────────────────
const now          = () => Date.now();
const ADMIN_PW     = "Beuss31608";
const INTERVAL_MS  = { daily:86400000, weekly:604800000, monthly:2592000000, yearly:31536000000 };
const INTERVAL_LBL = { daily:"Täglich", weekly:"Wöchentlich", monthly:"Monatlich", yearly:"Jährlich" };
const AUTO_DEL_MS  = 60 * 60 * 1000; // 1h after end

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtTime = (ms) => {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const fmtCD = (ms) => {
  if (ms <= 0) return "00:00:00";
  const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
};
const fmtFull = (ts) => {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
};
const parseDT = (date, time) => {
  if (!date || !time) return null;
  const [y,mo,d] = date.split("-").map(Number);
  const [h,mi]   = time.split(":").map(Number);
  return new Date(y, mo-1, d, h, mi, 0, 0).getTime();
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

// ─── Event processing ─────────────────────────────────────────────────────────
const processEvents = (evs) => evs.map(ev => {
  let e = ev;
  if (e.status==="scheduled" && e.scheduledFor && now()>=e.scheduledFor)
    e = {...e, status:"running", startedAt:now(), scheduledFor:null};
  if (e.type==="recurring" && e.status==="running" && e.startedAt) {
    const intv = INTERVAL_MS[e.interval] || INTERVAL_MS.daily;
    if (now()-e.startedAt >= intv) e = {...e, queue:[], startedAt:now()};
  }
  // Auto-delete 1h after ended
  if (e.status==="ended" && e.endedAt && now()-e.endedAt >= AUTO_DEL_MS)
    return null; // signal deletion
  return e;
}).filter(Boolean);

const STATUS = {
  idle:      {label:"○ Bereit",   color:"#666677"},
  scheduled: {label:"⏰ Geplant", color:"#ffd166"},
  running:   {label:"● Live",     color:"#06d6a0"},
  ended:     {label:"■ Beendet",  color:"#ef233c"},
};

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen]   = useState("home");
  const [events, setEvents]   = useState([]);
  const [courses, setCourses] = useState([]);
  const [users, setUsers]     = useState([]);
  const [,setTick]            = useState(0);

  // Home/login
  const [homeMode, setHomeMode]   = useState(null); // null | admin | customer
  const [loginPw, setLoginPw]     = useState("");
  const [loginUser, setLoginUser] = useState("");
  const [loginErr, setLoginErr]   = useState("");
  const [custPwErr, setCustPwErr] = useState("");

  // QR Modal
  const [qrModal, setQrModal]     = useState(null); // { name, password, type } | null
  const [qrBaseUrl, setQrBaseUrl] = useState("");
  const qrCanvasRef               = useRef();

  // Admin
  const [adminRole, setAdminRole]       = useState("super"); // super | dj | viewer
  const [adminTab, setAdminTab]         = useState("events");
  const [activeEventId, setActiveEventId] = useState(null);
  const [activeCourseId, setActiveCourseId] = useState(null);
  const [evFilter, setEvFilter]         = useState("all");

  // New event form
  const [nName, setNName]         = useState("");
  const [nPw, setNPw]             = useState("");
  const [nType, setNType]         = useState("oneoff");
  const [nInterval, setNInterval] = useState("daily");
  const [nStartMode, setNStartMode] = useState("manual");
  const [nSchedDate, setNSchedDate] = useState("");
  const [nSchedTime, setNSchedTime] = useState("");
  const [nBg, setNBg]             = useState(""); // base64 bg image
  const [showCreate, setShowCreate] = useState(false);
  const bgRef = useRef();

  // Course sorting
  const [coSort, setCoSort] = useState("title-asc"); // title-asc|title-desc|artist-asc|artist-desc|plays-asc|plays-desc

  // New course form
  const [cName, setCName]   = useState("");
  const [cPw, setCPw]       = useState("");
  const [cBg, setCBg]       = useState("");
  const [showCCreate, setShowCCreate] = useState(false);
  const cBgRef = useRef();

  // New user form
  const [uName, setUName] = useState("");
  const [uPw, setUPw]     = useState("");
  const [uRole, setURole] = useState("dj");
  const [uErr, setUErr]   = useState("");
  // Password change
  const [changingPwId, setChangingPwId] = useState(null); // user id or "super"
  const [newPwVal, setNewPwVal]         = useState("");
  const [newPwVal2, setNewPwVal2]       = useState("");
  const [pwChangeErr, setPwChangeErr]   = useState("");
  const [pwChangeOk, setPwChangeOk]     = useState(false);
  // Superadmin password (mutable in session)
  const [superPw, setSuperPw]           = useState(ADMIN_PW);

  // Customer
  const [custId, setCustId]         = useState(null); // event or course id
  const [votedIds, setVotedIds]     = useState(new Set()); // req IDs already voted on
  const [custMode, setCustMode]     = useState(null); // "event" | "course"
  const [custMsg, setCustMsg]       = useState("");
  const [custArtist, setCustArtist] = useState("");
  const [custTitle, setCustTitle]   = useState("");
  const [custFirst, setCustFirst]   = useState(""); // course: Vorname
  const [custLast, setCustLast]     = useState(""); // course: Nachname

  // ─── Load QRCode library from CDN ────────────────────────────────────────────
  useEffect(() => {
    if (window.QRCode) return;
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = () => {};
    document.head.appendChild(s);
  }, []);

  // ─── QR Code generation ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!qrModal || !qrCanvasRef.current) return;
    const el = qrCanvasRef.current;
    el.innerHTML = "";
    const url = qrBaseUrl.trim()
      ? `${qrBaseUrl.trim()}?pw=${encodeURIComponent(qrModal.password)}`
      : `${window.location.origin}?pw=${encodeURIComponent(qrModal.password)}`;
    const tryGen = () => {
      if (window.QRCode) {
        new window.QRCode(el, {
          text: url, width: 240, height: 240,
          colorDark: "#0a0a0f", colorLight: "#f0f0f5",
          correctLevel: window.QRCode.CorrectLevel.M
        });
      } else {
        setTimeout(tryGen, 100);
      }
    };
    tryGen();
  }, [qrModal, qrBaseUrl]);

  // ─── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([load(SK_EVENTS), load(SK_COURSES), load(SK_USERS)]).then(([evs,cos,us]) => {
      const processed = processEvents(evs || []);
      setEvents(processed); save(SK_EVENTS, processed);
      setCourses(cos || []);
      setUsers(us || []);
    });
  }, []);

  // Tick: auto-process events (reset, auto-delete, scheduled start)
  useEffect(() => {
    const t = setInterval(() => {
      setTick(x => x+1);
      setEvents(prev => {
        const updated = processEvents(prev);
        if (JSON.stringify(updated) !== JSON.stringify(prev)) { save(SK_EVENTS, updated); return updated; }
        return prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const persistEv  = (e) => { setEvents(e);   save(SK_EVENTS,  e); };
  const persistCo  = (c) => { setCourses(c);  save(SK_COURSES, c); };
  const persistUs  = (u) => { setUsers(u);    save(SK_USERS,   u); };

  // ─── Image helper ──────────────────────────────────────────────────────────
  const readImage = (file, cb) => {
    const r = new FileReader();
    r.onload = e => cb(e.target.result);
    r.readAsDataURL(file);
  };

  // ─── Login ─────────────────────────────────────────────────────────────────
  const handleLogin = () => {
    if (homeMode === "admin") {
      const isSuper   = loginPw.trim() === superPw && loginUser.trim() === "";
      const userMatch = users.find(u => u.name.toLowerCase()===loginUser.trim().toLowerCase() && u.password===loginPw.trim());
      if (isSuper || userMatch) {
        setAdminRole(isSuper ? "super" : userMatch.role);
        setScreen("admin"); setLoginErr(""); setLoginPw(""); setLoginUser("");
      } else setLoginErr("Benutzername oder Passwort falsch");
    } else {
      // Check events first, then courses
      const ev = events.find(e => e.password===loginPw);
      if (ev) { setCustId(ev.id); setCustMode("event"); setScreen("customer"); setCustPwErr(""); setLoginPw(""); setVotedIds(new Set()); return; }
      const co = courses.find(c => c.password===loginPw);
      if (co) { setCustId(co.id); setCustMode("course"); setScreen("customer"); setCustPwErr(""); setLoginPw(""); return; }
      setCustPwErr("Kein Event / Kurs mit diesem Passwort gefunden");
    }
  };

  // ─── Event actions ─────────────────────────────────────────────────────────
  const createEvent = () => {
    if (!nName.trim() || !nPw.trim()) return;
    if (nStartMode === "scheduled" && (!nSchedDate || !nSchedTime)) {
      alert("Bitte Datum und Uhrzeit für den geplanten Start angeben.");
      return;
    }
    const scheduledFor = nStartMode === "scheduled" ? parseDT(nSchedDate, nSchedTime) : null;
    if (scheduledFor && scheduledFor <= now()) {
      alert("Der geplante Startzeitpunkt muss in der Zukunft liegen.");
      return;
    }
    const ev = {
      id: now().toString(), name:nName.trim(), password:nPw.trim(),
      type:nType, interval:nType==="recurring"?nInterval:null,
      status: nStartMode==="scheduled"?"scheduled":"idle",
      scheduledFor,
      startedAt:null, endedAt:null, bg:nBg, queue:[],
    };
    persistEv([...events, ev]);
    setNName(""); setNPw(""); setNType("oneoff"); setNInterval("daily");
    setNStartMode("manual"); setNSchedDate(""); setNSchedTime(""); setNBg(""); setShowCreate(false);
  };

  const startEvent = (id) => persistEv(events.map(ev => ev.id!==id?ev:{...ev,status:"running",startedAt:now(),scheduledFor:null}));
  const endEvent   = (id) => persistEv(events.map(ev => ev.id!==id?ev:{...ev,status:"ended",endedAt:now()}));
  const stopEvent  = (id) => persistEv(events.map(ev => ev.id!==id?ev:{...ev,status:"idle",startedAt:null}));
  const deleteEvent= (id) => persistEv(events.filter(e => e.id!==id));
  const resetCycle = (id) => persistEv(events.map(ev => ev.id!==id?ev:{...ev,queue:[],startedAt:now()}));
  const updateEventBg = (id, bg) => persistEv(events.map(ev => ev.id!==id?ev:{...ev,bg}));

  const setReqStatus = (evId, reqId, st) => persistEv(events.map(ev => ev.id!==evId?ev:
    {...ev, queue:ev.queue.map(r => r.id===reqId?{...r,status:st}:r)}));

  // Vote: bump votes count, re-sort pending by votes desc; one vote per title per session
  const voteForReq = (evId, reqId) => {
    if (votedIds.has(reqId)) return; // already voted
    setVotedIds(prev => new Set([...prev, reqId]));
    persistEv(events.map(ev => {
      if (ev.id !== evId) return ev;
      const queue = ev.queue.map(r => r.id===reqId ? {...r, votes:(r.votes||0)+1} : r);
      const pending = queue.filter(r=>r.status==="pending").sort((a,b)=>(b.votes||0)-(a.votes||0));
      const rest    = queue.filter(r=>r.status!=="pending");
      return {...ev, queue:[...pending,...rest]};
    }));
  };

  // ─── Course actions ────────────────────────────────────────────────────────
  const createCourse = () => {
    if (!cName.trim() || !cPw.trim()) return;
    const co = { id:now().toString(), name:cName.trim(), password:cPw.trim(), bg:cBg, entries:[] };
    persistCo([...courses, co]);
    setCName(""); setCPw(""); setCBg(""); setShowCCreate(false);
  };
  const updateCourseBg = (id, bg) => persistCo(courses.map(c => c.id!==id?c:{...c,bg}));

  const addPlayCount  = (coId, entryId) => persistCo(courses.map(co => co.id!==coId?co:
    {...co, entries:co.entries.map(e => e.id===entryId?{...e,plays:(e.plays||0)+1}:e)}));
  const removeEntry   = (coId, entryId) => persistCo(courses.map(co => co.id!==coId?co:
    {...co, entries:co.entries.filter(e => e.id!==entryId)}));
  const deleteCourse  = (id) => persistCo(courses.filter(c => c.id!==id));

  // ─── Customer submit ───────────────────────────────────────────────────────
  const submitRequest = () => {
    if (!custArtist.trim() && !custTitle.trim()) return;
    if (custMode === "event") {
      const req = { id:now().toString(), title:custTitle.trim(), artist:custArtist.trim(), addedAt:now(), status:"pending", votes:0 };
      persistEv(events.map(ev => ev.id!==custId?ev:{...ev,queue:[...ev.queue,req]}));
    } else {
      if (!custFirst.trim() && !custLast.trim()) return;
      const entry = { id:now().toString(), title:custTitle.trim(), artist:custArtist.trim(),
        firstName:custFirst.trim(), lastName:custLast.trim(), addedAt:now(), plays:0 };
      persistCo(courses.map(co => co.id!==custId?co:{...co,entries:[...co.entries,entry]}));
    }
    setCustArtist(""); setCustTitle(""); setCustFirst(""); setCustLast("");
    setCustMsg("Dein Wunsch wurde eingereicht! 🎵");
    setTimeout(() => setCustMsg(""), 3000);
  };

  // ─── Users ─────────────────────────────────────────────────────────────────
  const createUser = () => {
    if (!uName.trim()||!uPw.trim()) { setUErr("Name und Passwort erforderlich"); return; }
    if (users.find(u=>u.name===uName.trim())) { setUErr("Benutzername bereits vergeben"); return; }
    persistUs([...users,{id:now().toString(),name:uName.trim(),password:uPw.trim(),role:uRole}]);
    setUName(""); setUPw(""); setURole("dj"); setUErr("");
  };
  const deleteUser = (id) => persistUs(users.filter(u=>u.id!==id));

  const submitPasswordChange = () => {
    setPwChangeErr(""); setPwChangeOk(false);
    if (!newPwVal.trim()) { setPwChangeErr("Passwort darf nicht leer sein."); return; }
    if (newPwVal !== newPwVal2) { setPwChangeErr("Passwörter stimmen nicht überein."); return; }
    if (newPwVal.length < 6) { setPwChangeErr("Mindestens 6 Zeichen erforderlich."); return; }
    if (changingPwId === "super") {
      setSuperPw(newPwVal);
    } else {
      persistUs(users.map(u => u.id !== changingPwId ? u : {...u, password: newPwVal}));
    }
    setNewPwVal(""); setNewPwVal2(""); setPwChangeOk(true);
    setTimeout(() => { setPwChangeOk(false); setChangingPwId(null); }, 2000);
  };

  // ─── Derived ───────────────────────────────────────────────────────────────
  const activeEv     = events.find(e=>e.id===activeEventId);
  const activeCo     = courses.find(c=>c.id===activeCourseId);
  const custEvent    = custMode==="event"  ? events.find(e=>e.id===custId)  : null;
  const custCourse   = custMode==="course" ? courses.find(c=>c.id===custId) : null;
  const filteredEvs  = evFilter==="all" ? events : events.filter(e=>e.status===evFilter);

  // ─── CSS ───────────────────────────────────────────────────────────────────
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --bg:#0a0a0f;--surface:#13131a;--surface2:#1c1c26;--border:#1e1e2a;
      --accent:#ff3c6e;--accent2:#ff8c42;--gold:#ffd166;
      --text:#f0f0f5;--muted:#666677;--green:#06d6a0;--red:#ef233c;
      --blue:#4ecdc4;--purple:#9b5de5;--orange:#ff8c42;--r:12px;
    }
    body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh;}
    .app{min-height:100vh;display:flex;flex-direction:column;}

    /* NAV */
    .nav{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;
      border-bottom:1px solid var(--border);background:var(--bg);position:sticky;top:0;z-index:20;}
    .nav-logo{font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:3px;color:var(--accent);}
    .nav-back{background:none;border:1px solid #2a2a38;color:var(--muted);padding:6px 14px;
      border-radius:6px;cursor:pointer;font-size:13px;transition:all .2s;}
    .nav-back:hover{color:var(--text);border-color:var(--accent);}

    /* HOME */
    .home{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;gap:48px;}
    .hero h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(48px,10vw,96px);letter-spacing:6px;
      background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;
      -webkit-text-fill-color:transparent;background-clip:text;line-height:1;text-align:center;}
    .hero p{color:var(--muted);font-size:15px;margin-top:8px;letter-spacing:1px;text-align:center;}
    .role-cards{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;align-items:stretch;}
    .role-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
      padding:32px 40px;cursor:pointer;text-align:center;transition:all .25s;width:200px;
      display:flex;flex-direction:column;align-items:center;justify-content:center;}
    .role-card:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 12px 40px rgba(255,60,110,.15);}
    .role-card .icon{font-size:36px;margin-bottom:12px;}
    .role-card h3{font-size:16px;font-weight:500;}
    .role-card p{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.4;}
    .login-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
      padding:32px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px;}
    .login-panel h2{font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:3px;}

    /* INPUTS */
    .inp{background:var(--surface2);border:1px solid #2a2a38;border-radius:8px;padding:11px 14px;
      color:var(--text);font-size:14px;outline:none;width:100%;transition:border-color .2s;font-family:inherit;}
    .inp:focus{border-color:var(--accent);}
    .inp-time{background:var(--surface2);border:1px solid #2a2a38;border-radius:8px;padding:11px 14px;
      color:var(--text);font-size:14px;outline:none;transition:border-color .2s;font-family:inherit;color-scheme:dark;}
    .inp-time:focus{border-color:var(--gold);}
    select.inp{cursor:pointer;}

    /* BUTTONS */
    .btn{padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-size:14px;
      font-family:inherit;font-weight:500;transition:all .2s;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;}
    .btn-primary{background:var(--accent);color:white;}
    .btn-primary:hover{background:#ff5580;}
    .btn-ghost{background:transparent;color:var(--muted);border:1px solid #2a2a38;}
    .btn-ghost:hover{color:var(--text);border-color:#555;}
    .btn-sm{padding:5px 11px;font-size:12px;border-radius:6px;}
    .btn-xs{padding:3px 8px;font-size:11px;border-radius:5px;}
    .btn-danger{background:transparent;border:1px solid var(--red);color:var(--red);}
    .btn-danger:hover{background:var(--red);color:white;}
    .btn-warn{background:transparent;border:1px solid var(--accent2);color:var(--accent2);}
    .btn-warn:hover{background:var(--accent2);color:white;}
    .btn-success{background:transparent;border:1px solid var(--green);color:var(--green);}
    .btn-success:hover{background:var(--green);color:#0a0a0f;}
    .btn-blue{background:transparent;border:1px solid var(--blue);color:var(--blue);}
    .btn-blue:hover{background:var(--blue);color:#0a0a0f;}
    .btn-gold{background:transparent;border:1px solid var(--gold);color:var(--gold);}
    .btn-gold:hover{background:var(--gold);color:#0a0a0f;}
    .btn-purple{background:transparent;border:1px solid var(--purple);color:var(--purple);}
    .btn-purple:hover{background:var(--purple);color:white;}
    .btn-vote{background:transparent;border:1px solid #333;color:var(--muted);padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:4px;}
    .btn-vote:hover{border-color:var(--accent);color:var(--accent);}
    .btn-vote.voted{border-color:var(--accent);color:var(--accent);background:rgba(255,60,110,.08);}
    .error{color:var(--red);font-size:13px;}

    /* ADMIN LAYOUT */
    .admin-wrap{flex:1;padding:20px 24px;max-width:1100px;margin:0 auto;width:100%;}
    .tabs{display:flex;gap:4px;margin-bottom:22px;background:var(--surface);padding:4px;border-radius:8px;width:fit-content;flex-wrap:wrap;}
    .tab{padding:8px 18px;border-radius:6px;border:none;cursor:pointer;font-family:inherit;font-size:14px;transition:all .2s;background:none;color:var(--muted);}
    .tab.active{background:var(--accent);color:white;font-weight:500;}
    .section-hd{font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px;color:var(--muted);}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:20px;}

    /* FILTER BAR */
    .filter-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px;align-items:center;}
    .filter-btn{padding:5px 13px;border-radius:20px;border:1px solid var(--border);background:none;
      color:var(--muted);font-family:inherit;font-size:12px;cursor:pointer;transition:all .2s;}
    .filter-btn.active{background:var(--surface2);color:var(--text);border-color:#444;}
    .filter-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px;}

    /* TILES GRID */
    .tiles-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;}

    /* TILE – shared */
    .tile{border:1px solid var(--border);border-radius:14px;overflow:hidden;
      display:flex;flex-direction:column;transition:box-shadow .2s;position:relative;}
    .tile:hover{box-shadow:0 4px 28px rgba(0,0,0,.5);}
    .tile-bg{position:absolute;inset:0;background-size:cover;background-position:center;z-index:0;}
    .tile-bg-overlay{position:absolute;inset:0;background:rgba(10,10,15,.72);z-index:1;}
    .tile-inner{position:relative;z-index:2;display:flex;flex-direction:column;height:100%;}
    .tile.no-bg{background:var(--surface);}
    .tile.st-running{border-color:rgba(6,214,160,.35);}
    .tile.st-scheduled{border-color:rgba(255,209,102,.35);}
    .tile.st-ended{border-color:rgba(239,35,60,.2);opacity:.78;}
    .tile.course-tile{border-color:rgba(155,93,229,.35);}

    .tile-header{padding:16px 18px 12px;}
    .tile-status{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
    .tile-status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
    .tile-status-txt{font-size:12px;font-weight:600;letter-spacing:.5px;}
    .tile-name{font-size:17px;font-weight:600;line-height:1.2;margin-bottom:6px;}
    .tile-badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}
    .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;}
    .badge-oneoff{background:rgba(255,60,110,.12);color:var(--accent);border:1px solid rgba(255,60,110,.3);}
    .badge-recurring{background:rgba(78,205,196,.12);color:var(--blue);border:1px solid rgba(78,205,196,.3);}
    .badge-course{background:rgba(155,93,229,.12);color:var(--purple);border:1px solid rgba(155,93,229,.3);}
    .tile-meta{font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px;}
    .pw-tag{font-size:11px;background:var(--surface2);border:1px solid #2a2a38;padding:1px 7px;border-radius:4px;color:var(--muted);font-family:monospace;}

    /* Tile strips */
    .tile-countdown{padding:8px 18px;background:rgba(78,205,196,.08);border-top:1px solid rgba(78,205,196,.18);
      display:flex;align-items:center;gap:10px;}
    .tile-countdown-time{font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:2px;color:var(--blue);}
    .tile-countdown-lbl{font-size:10px;color:var(--blue);text-transform:uppercase;letter-spacing:1px;}
    .tile-prog{flex:1;height:3px;background:#1e1e2a;border-radius:3px;overflow:hidden;}
    .tile-prog-fill{height:100%;background:var(--blue);border-radius:3px;transition:width 1s linear;}
    .tile-sched-strip{padding:8px 18px;background:rgba(255,209,102,.06);border-top:1px solid rgba(255,209,102,.18);display:flex;align-items:center;gap:8px;}
    .tile-sched-time{font-family:'Bebas Neue',sans-serif;font-size:14px;letter-spacing:1px;color:var(--gold);}
    .tile-sched-lbl{font-size:10px;color:var(--gold);text-transform:uppercase;letter-spacing:1px;}
    .tile-autodel{padding:6px 18px;background:rgba(239,35,60,.06);border-top:1px solid rgba(239,35,60,.15);font-size:11px;color:var(--red);}

    /* Tile footer */
    .tile-footer{padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;align-items:center;}

    /* BG upload button inside tile */
    .tile-bg-btn{font-size:11px;padding:4px 9px;border-radius:5px;border:1px dashed #444;background:transparent;color:var(--muted);cursor:pointer;transition:all .2s;}
    .tile-bg-btn:hover{border-color:var(--accent);color:var(--accent);}

    /* CREATE FORM */
    .create-panel{margin-bottom:20px;}
    .create-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;}
    .form-label{font-size:11px;color:var(--muted);margin-bottom:4px;letter-spacing:.5px;text-transform:uppercase;}
    .form-group{display:flex;flex-direction:column;}
    .form-group.full{grid-column:1/-1;}
    .seg{display:flex;border-radius:8px;overflow:hidden;border:1px solid #2a2a38;}
    .seg-btn{flex:1;padding:10px 10px;border:none;cursor:pointer;font-family:inherit;font-size:12px;
      font-weight:500;background:var(--surface2);color:var(--muted);transition:all .2s;text-align:center;}
    .seg-btn.a-pink{background:var(--accent);color:white;}
    .seg-btn.a-blue{background:var(--blue);color:#0a0a0f;}
    .seg-btn.a-gold{background:var(--gold);color:#0a0a0f;}
    .seg-btn.a-green{background:var(--green);color:#0a0a0f;}
    .seg-btn.a-purple{background:var(--purple);color:white;}
    .hint{font-size:11px;color:var(--muted);margin-top:4px;}
    .sched-row{display:flex;align-items:center;gap:8px;margin-top:8px;background:rgba(255,209,102,.05);
      border:1px solid rgba(255,209,102,.2);border-radius:8px;padding:10px 12px;flex-wrap:wrap;}
    .sched-row span{font-size:14px;color:var(--gold);}

    /* BG preview in form */
    .bg-preview{width:100%;height:60px;border-radius:8px;object-fit:cover;margin-top:6px;border:1px solid var(--border);}

    /* QUEUE */
    .queue-wrap{display:flex;flex-direction:column;gap:8px;}
    .q-header-row{display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap;}
    .queue-item{background:var(--surface2);border:1px solid var(--border);border-radius:10px;
      padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
    .queue-item.inappropriate{border-color:rgba(239,35,60,.25);opacity:.7;}
    .queue-item.played{opacity:.4;}
    .queue-num{font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--muted);min-width:30px;}
    .queue-info{flex:1;}
    .queue-title{font-weight:500;font-size:14px;}
    .queue-artist{font-size:12px;color:var(--muted);}
    .queue-timer{font-size:11px;color:var(--accent2);font-variant-numeric:tabular-nums;white-space:nowrap;}
    .queue-votes{font-size:12px;color:var(--accent);font-weight:600;white-space:nowrap;}
    .queue-actions{display:flex;gap:5px;flex-wrap:wrap;}
    .divider{height:1px;background:var(--border);margin:14px 0;}
    .sub-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:8px;}
    .countdown-banner{background:rgba(78,205,196,.07);border:1px solid rgba(78,205,196,.2);border-radius:10px;
      padding:12px 16px;display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap;}
    .banner-time{font-family:'Bebas Neue',sans-serif;font-size:28px;letter-spacing:3px;color:var(--blue);line-height:1;}
    .banner-lbl{font-size:10px;color:var(--blue);letter-spacing:1.5px;text-transform:uppercase;}
    .banner-sub{font-size:11px;color:var(--muted);margin-top:2px;}
    .prog-track{flex:1;min-width:60px;height:5px;background:var(--border);border-radius:4px;overflow:hidden;}
    .prog-fill{height:100%;background:var(--blue);border-radius:4px;transition:width 1s linear;}
    .notice{border-radius:10px;padding:12px 16px;margin-bottom:14px;font-size:13px;
      display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
    .notice-warn{background:rgba(255,209,102,.07);border:1px solid rgba(255,209,102,.2);color:var(--gold);}
    .notice-red{background:rgba(239,35,60,.07);border:1px solid rgba(239,35,60,.2);color:var(--red);}

    /* COURSE TABLE */
    .course-table{width:100%;border-collapse:collapse;font-size:13px;}
    .course-table th{text-align:left;padding:8px 12px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--border);}
    .course-table td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle;}
    .course-table tr:last-child td{border-bottom:none;}
    .play-count{display:inline-flex;align-items:center;gap:6px;}
    .play-badge{font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--purple);min-width:28px;}

    /* USERS */
    .user-list{display:flex;flex-direction:column;gap:8px;margin-top:16px;}
    .user-item{background:var(--surface2);border:1px solid var(--border);border-radius:10px;
      padding:12px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
    .user-name{font-weight:500;font-size:14px;flex:1;}
    .role-badge{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;}
    .role-dj{background:rgba(155,93,229,.15);color:var(--purple);border:1px solid rgba(155,93,229,.3);}
    .role-viewer{background:rgba(102,102,119,.1);color:var(--muted);border:1px solid #2a2a38;}

    /* CUSTOMER */
    .cust-wrap{flex:1;padding:24px;max-width:600px;margin:0 auto;width:100%;display:flex;flex-direction:column;gap:20px;}
    .cust-header{text-align:center;padding:24px;border-radius:14px;background:var(--surface);border:1px solid var(--border);background-size:cover;background-position:center;position:relative;overflow:hidden;}
    .cust-header-overlay{position:absolute;inset:0;background:rgba(10,10,15,.65);}
    .cust-header-inner{position:relative;z-index:1;}
    .cust-header h2{font-family:'Bebas Neue',sans-serif;font-size:32px;letter-spacing:3px;}
    .cust-header p{color:var(--muted);font-size:13px;margin-top:4px;}
    .request-form{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:22px;display:flex;flex-direction:column;gap:11px;}
    .request-form h3{font-size:14px;font-weight:600;margin-bottom:2px;}
    .success-msg{background:rgba(6,214,160,.1);border:1px solid rgba(6,214,160,.3);color:var(--green);
      padding:11px 14px;border-radius:8px;font-size:13px;text-align:center;}
    .status-msg{border-radius:10px;padding:16px;font-size:14px;text-align:center;}
    .status-msg.warn{background:rgba(255,209,102,.07);border:1px solid rgba(255,209,102,.2);color:var(--gold);}
    .status-msg.ended{background:rgba(239,35,60,.07);border:1px solid rgba(239,35,60,.2);color:var(--red);}
    .queue-cust{display:flex;flex-direction:column;gap:7px;}
    .qci{background:var(--surface);border:1px solid var(--border);border-radius:10px;
      padding:11px 14px;display:flex;align-items:center;gap:10px;}
    .qci.played{opacity:.4;}
    .q-num{font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--muted);min-width:26px;}
    .q-info .q-title{font-size:13px;font-weight:500;}
    .q-info .q-artist{font-size:12px;color:var(--muted);}
    .played-tag{font-size:11px;color:var(--green);margin-left:auto;}
    .vote-area{margin-left:auto;display:flex;align-items:center;gap:6px;}
    .vote-count{font-size:12px;color:var(--accent);font-weight:600;}
    .empty{color:var(--muted);font-size:13px;text-align:center;padding:28px;}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}

    /* QR MODAL */
    .qr-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:100;display:flex;align-items:center;justify-content:center;padding:24px;}
    .qr-modal{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;max-width:400px;width:100%;display:flex;flex-direction:column;gap:16px;animation:qrIn .2s ease;}
    @keyframes qrIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
    .qr-modal h3{font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:2px;color:var(--text);}
    .qr-canvas-wrap{display:flex;justify-content:center;background:var(--surface2);border-radius:12px;padding:16px;border:1px solid var(--border);}
    .qr-canvas-wrap canvas{border-radius:6px;}
    .qr-url{font-size:11px;color:var(--muted);word-break:break-all;background:var(--surface2);padding:8px 10px;border-radius:6px;border:1px solid var(--border);font-family:monospace;}
    .qr-actions{display:flex;gap:8px;flex-wrap:wrap;}

    /* PASSWORD CHANGE */
    .pw-change-form{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;margin-top:8px;}
    .pw-change-form .form-label{margin-bottom:2px;}
    .pw-ok{font-size:13px;color:var(--green);}
  `;

  // ─── RENDER ────────────────────────────────────────────────────────────────
  const TileBg = ({bg, children}) => bg
    ? <div className="tile" style={{background:"transparent"}}>
        <div className="tile-bg" style={{backgroundImage:`url(${bg})`}}/>
        <div className="tile-bg-overlay"/>
        <div className="tile-inner">{children}</div>
      </div>
    : <div className="tile no-bg">{children}</div>;

  return (
    <>
      <style>{css}</style>
      <div className="app">

        {/* NAV */}
        <nav className="nav">
          <span className="nav-logo">🎵 BQueue</span>
          {screen !== "home" && (
            <button className="nav-back" onClick={() => {
              setScreen("home"); setHomeMode(null); setActiveEventId(null); setActiveCourseId(null); setCustId(null); setCustMode(null);
            }}>← Zurück</button>
          )}
        </nav>

        {/* ── HOME ──────────────────────────────────────────────────────────── */}
        {screen === "home" && (
          <div className="home">
            <div className="hero"><h1>BQueue</h1><p>Musikwünsche & Kurslisten verwalten</p></div>
            {!homeMode && (
              <div className="role-cards">
                <div className="role-card" onClick={() => setHomeMode("admin")}>
                  <div className="icon">🎛️</div><h3>Admin / DJ</h3><p>Events & Kurse verwalten</p>
                </div>
                <div className="role-card" onClick={() => setHomeMode("customer")}>
                  <div className="icon">🎤</div><h3>Gast / Teilnehmer</h3><p>Musikwunsch einreichen</p>
                </div>
              </div>
            )}
            {homeMode && (
              <div className="login-panel">
                <h2>{homeMode==="admin" ? "Admin Login" : "Beitreten"}</h2>
                {homeMode==="admin" && (
                  <input className="inp" placeholder="Benutzername (leer = Superadmin)"
                    value={loginUser} onChange={e=>setLoginUser(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&handleLogin()} />
                )}
                <input className="inp" type="password" placeholder="Passwort"
                  value={loginPw} onChange={e=>setLoginPw(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&handleLogin()} />
                {(loginErr||custPwErr) && <span className="error">{loginErr||custPwErr}</span>}
                <button className="btn btn-primary" onClick={handleLogin}>Einloggen</button>
                <button className="btn btn-ghost" onClick={()=>{setHomeMode(null);setLoginErr("");setCustPwErr("");setLoginPw("");setLoginUser("");}}>Abbrechen</button>
              </div>
            )}
          </div>
        )}

        {/* ── ADMIN ─────────────────────────────────────────────────────────── */}
        {screen==="admin" && (
          <div className="admin-wrap">
            <div className="tabs">
              <button className={`tab ${adminTab==="events"?"active":""}`} onClick={()=>setAdminTab("events")}>📋 Events</button>
              <button className={`tab ${adminTab==="courses"?"active":""}`} onClick={()=>setAdminTab("courses")}>📚 Kurse</button>
              <button className={`tab ${adminTab==="queue"?"active":""}`} onClick={()=>setAdminTab("queue")}>🎵 Warteschlange</button>
              <button className={`tab ${adminTab==="users"?"active":""}`} onClick={()=>setAdminTab("users")}>👤 Benutzer</button>
            </div>

            {/* Viewer notice */}
            {adminRole==="viewer"&&(
              <div style={{background:"rgba(78,205,196,.07)",border:"1px solid rgba(78,205,196,.2)",borderRadius:8,padding:"10px 16px",marginBottom:16,fontSize:13,color:"var(--blue)"}}>
                👁 Du bist als <strong>Beobachter</strong> eingeloggt – du kannst alle Listen einsehen, Warteschlangen verwalten und PlayCounter nutzen. Erstellen, Löschen von Events/Kursen sowie der Zyklus-Reset sind gesperrt.
              </div>
            )}

            {/* ── EVENTS TAB ───────────────────────────────────────────────── */}
            {adminTab==="events" && (<>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                <span className="section-hd">Events ({events.length})</span>
                <button className="btn btn-primary btn-sm" onClick={()=>setShowCreate(x=>!x)}>
                  {showCreate?"✕ Abbrechen":"+ Neues Event"}
                </button>
              </div>

              {showCreate && (
                <div className="card create-panel">
                  <div className="create-grid">
                    <div className="form-group">
                      <div className="form-label">Event-Name</div>
                      <input className="inp" placeholder="z.B. Club Friday" value={nName} onChange={e=>setNName(e.target.value)}/>
                    </div>
                    <div className="form-group">
                      <div className="form-label">Passwort für Gäste</div>
                      <input className="inp" placeholder="Geheimwort" value={nPw} onChange={e=>setNPw(e.target.value)}/>
                    </div>
                    <div className="form-group">
                      <div className="form-label">Event-Typ</div>
                      <div className="seg">
                        <button className={`seg-btn ${nType==="oneoff"?"a-pink":""}`} onClick={()=>setNType("oneoff")}>🎯 Einmalig</button>
                        <button className={`seg-btn ${nType==="recurring"?"a-blue":""}`} onClick={()=>setNType("recurring")}>🔄 Wiederkehrend</button>
                      </div>
                    </div>
                    {nType==="recurring" && (
                      <div className="form-group">
                        <div className="form-label">Intervall</div>
                        <select className="inp" value={nInterval} onChange={e=>setNInterval(e.target.value)}>
                          <option value="daily">Täglich (24h)</option>
                          <option value="weekly">Wöchentlich</option>
                          <option value="monthly">Monatlich</option>
                          <option value="yearly">Jährlich</option>
                        </select>
                      </div>
                    )}
                    <div className="form-group">
                      <div className="form-label">Start</div>
                      <div className="seg">
                        <button className={`seg-btn ${nStartMode==="manual"?"a-green":""}`} onClick={()=>setNStartMode("manual")}>▶ Manuell</button>
                        <button className={`seg-btn ${nStartMode==="scheduled"?"a-gold":""}`} onClick={()=>setNStartMode("scheduled")}>⏰ Uhrzeit</button>
                      </div>
                      {nStartMode==="scheduled" && (
                        <div className="sched-row">
                          <span>📅</span>
                          <input className="inp-time" type="date" value={nSchedDate} min={todayStr()} onChange={e=>setNSchedDate(e.target.value)}/>
                          <span>⏰</span>
                          <input className="inp-time" type="time" value={nSchedTime} onChange={e=>setNSchedTime(e.target.value)}/>
                        </div>
                      )}
                    </div>
                    <div className="form-group">
                      <div className="form-label">Kachelhintergrundbild</div>
                      <input ref={bgRef} type="file" accept="image/*" style={{display:"none"}}
                        onChange={e=>{ if(e.target.files[0]) readImage(e.target.files[0], setNBg); }}/>
                      <button className="tile-bg-btn" style={{alignSelf:"flex-start",marginTop:4}} onClick={()=>bgRef.current.click()}>
                        🖼 Bild hochladen
                      </button>
                      {nBg && <img src={nBg} className="bg-preview" alt="Vorschau"/>}
                      {nBg && <button className="btn-xs btn-ghost" style={{alignSelf:"flex-start",marginTop:4}} onClick={()=>setNBg("")}>✕ Entfernen</button>}
                    </div>
                    <div className="form-group full">
                      <button className="btn btn-primary" style={{alignSelf:"flex-start"}} onClick={createEvent}>+ Event erstellen</button>
                    </div>
                  </div>
                </div>
              )}

              <div className="filter-bar">
                {[["all","Alle",null],["idle","Bereit","#666677"],["scheduled","Geplant","#ffd166"],["running","Live","#06d6a0"],["ended","Beendet","#ef233c"]].map(([v,l,c])=>(
                  <button key={v} className={`filter-btn ${evFilter===v?"active":""}`} onClick={()=>setEvFilter(v)}>
                    {c&&<span className="filter-dot" style={{background:c}}/>}{l} ({v==="all"?events.length:events.filter(e=>e.status===v).length})
                  </button>
                ))}
              </div>

              <div className="tiles-grid">
                {filteredEvs.length===0 && <p className="empty" style={{gridColumn:"1/-1"}}>Keine Events</p>}
                {filteredEvs.map(ev => {
                  const st = STATUS[ev.status]||STATUS.idle;
                  const intv = ev.type==="recurring"?(INTERVAL_MS[ev.interval]||INTERVAL_MS.daily):null;
                  const msLeft = intv && ev.status==="running" && ev.startedAt ? intv-(now()-ev.startedAt) : null;
                  const msToStart = ev.status==="scheduled"&&ev.scheduledFor ? ev.scheduledFor-now() : null;
                  const msToDelete = ev.status==="ended"&&ev.endedAt ? AUTO_DEL_MS-(now()-ev.endedAt) : null;
                  const fileRef = { current: null };
                  return (
                    <TileBg key={ev.id} bg={ev.bg}>
                      <div className={`tile-header`} style={ev.bg?{color:"#fff"}:{}}>
                        <div className="tile-status">
                          <span className="tile-status-dot" style={{background:st.color}}/>
                          <span className="tile-status-txt" style={{color:st.color}}>{st.label}</span>
                        </div>
                        <div className="tile-name">{ev.name}</div>
                        <div className="tile-badges">
                          <span className={`badge badge-${ev.type}`}>
                            {ev.type==="oneoff"?"🎯 Einmalig":`🔄 ${INTERVAL_LBL[ev.interval]||"Täglich"}`}
                          </span>
                        </div>
                        <div className="tile-meta" style={ev.bg?{color:"rgba(255,255,255,.65)"}:{}}>
                          <span>PW: <span className="pw-tag">{ev.password}</span></span>
                          <span>📋 {ev.queue.filter(r=>r.status==="pending").length} ausstehend</span>
                          <span>✓ {ev.queue.filter(r=>r.status==="played").length} gespielt</span>
                          {ev.endedAt&&<span style={{color:"var(--red)",fontSize:11}}>Beendet: {fmtFull(ev.endedAt)}</span>}
                        </div>
                      </div>

                      {ev.type==="recurring"&&ev.status==="running"&&msLeft!==null&&(
                        <div className="tile-countdown">
                          <div><div className="tile-countdown-lbl">🔄 Reset in</div>
                          <div className="tile-countdown-time">{fmtCD(msLeft)}</div></div>
                          <div className="tile-prog"><div className="tile-prog-fill" style={{width:`${Math.max(0,msLeft/intv*100)}%`}}/></div>
                        </div>
                      )}
                      {ev.status==="scheduled"&&msToStart!==null&&(
                        <div className="tile-sched-strip">
                          <div><div className="tile-sched-lbl">⏰ Geplanter Start</div>
                          <div className="tile-sched-time">{fmtFull(ev.scheduledFor)} · {fmtCD(msToStart)}</div></div>
                        </div>
                      )}
                      {ev.status==="ended"&&msToDelete!==null&&(
                        <div className="tile-autodel">🗑 Wird automatisch gelöscht in {fmtCD(Math.max(0,msToDelete))}</div>
                      )}

                      <div className="tile-footer">
                        {ev.status==="idle"&&<button className="btn btn-success btn-sm" onClick={()=>startEvent(ev.id)}>▶ Starten</button>}
                        {ev.status==="scheduled"&&<><button className="btn btn-success btn-sm" onClick={()=>startEvent(ev.id)}>▶ Jetzt starten</button><button className="btn btn-ghost btn-sm" onClick={()=>stopEvent(ev.id)}>✕ Abbrechen</button></>}
                        {ev.status==="running"&&<>
                          <button className="btn btn-ghost btn-sm" onClick={()=>{setActiveEventId(ev.id);setAdminTab("queue");}}>🎵 Queue</button>
                          {adminRole!=="viewer"&&ev.type==="recurring"&&<button className="btn btn-blue btn-sm" onClick={()=>resetCycle(ev.id)}>↺ Reset</button>}
                          <button className="btn btn-danger btn-sm" onClick={()=>endEvent(ev.id)}>■ Beenden</button>
                        </>}
                        {(ev.status==="idle"||ev.status==="scheduled")&&<button className="btn btn-ghost btn-sm" onClick={()=>{setActiveEventId(ev.id);setAdminTab("queue");}}>🎵 Queue</button>}
                        {adminRole!=="viewer"&&ev.status==="ended"&&<button className="btn btn-danger btn-sm" onClick={()=>deleteEvent(ev.id)}>🗑 Löschen</button>}
                        {/* QR code button */}
                        <button className="tile-bg-btn" style={{marginLeft:"auto"}}
                          onClick={()=>setQrModal({name:ev.name,password:ev.password,type:"event"})}>
                          ⬛ QR
                        </button>
                        {/* BG upload on tile */}
                        <label style={{cursor:"pointer"}}>
                          <span className="tile-bg-btn">🖼</span>
                          <input type="file" accept="image/*" style={{display:"none"}}
                            onChange={e=>{ if(e.target.files[0]) readImage(e.target.files[0], bg=>updateEventBg(ev.id,bg)); }}/>
                        </label>
                        {ev.bg&&<button className="tile-bg-btn" onClick={()=>updateEventBg(ev.id,"")}>✕ Bild</button>}
                      </div>
                    </TileBg>
                  );
                })}
              </div>
            </>)}

            {/* ── COURSES TAB ──────────────────────────────────────────────── */}
            {adminTab==="courses" && (<>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                <span className="section-hd">Kurslisten ({courses.length})</span>
                {adminRole!=="viewer"&&<button className="btn btn-primary btn-sm" onClick={()=>setShowCCreate(x=>!x)}>
                  {showCCreate?"✕ Abbrechen":"+ Neue Kursliste"}
                </button>}
              </div>

              {showCCreate && adminRole!=="viewer" && (
                <div className="card create-panel">
                  <div className="create-grid">
                    <div className="form-group">
                      <div className="form-label">Kursname</div>
                      <input className="inp" placeholder="z.B. Zumba Dienstag" value={cName} onChange={e=>setCName(e.target.value)}/>
                    </div>
                    <div className="form-group">
                      <div className="form-label">Passwort für Teilnehmer</div>
                      <input className="inp" placeholder="Kurspasswort" value={cPw} onChange={e=>setCPw(e.target.value)}/>
                    </div>
                    <div className="form-group">
                      <div className="form-label">Kachelhintergrundbild</div>
                      <input ref={cBgRef} type="file" accept="image/*" style={{display:"none"}}
                        onChange={e=>{ if(e.target.files[0]) readImage(e.target.files[0], setCBg); }}/>
                      <button className="tile-bg-btn" style={{alignSelf:"flex-start",marginTop:4}} onClick={()=>cBgRef.current.click()}>
                        🖼 Bild hochladen
                      </button>
                      {cBg && <img src={cBg} className="bg-preview" alt="Vorschau"/>}
                      {cBg && <button className="btn-xs btn-ghost" style={{alignSelf:"flex-start",marginTop:4}} onClick={()=>setCBg("")}>✕ Entfernen</button>}
                    </div>
                    <div className="form-group full">
                      <button className="btn btn-purple" style={{alignSelf:"flex-start"}} onClick={createCourse}>+ Kurs erstellen</button>
                    </div>
                  </div>
                </div>
              )}

              <div className="tiles-grid">
                {courses.length===0 && <p className="empty" style={{gridColumn:"1/-1"}}>Noch keine Kurslisten</p>}
                {courses.map(co => (
                  <TileBg key={co.id} bg={co.bg}>
                    <div className="tile-header">
                      <div className="tile-status">
                        <span className="tile-status-dot" style={{background:"var(--purple)"}}/>
                        <span className="tile-status-txt" style={{color:"var(--purple)"}}>📚 Dauerhaft</span>
                      </div>
                      <div className="tile-name">{co.name}</div>
                      <div className="tile-badges"><span className="badge badge-course">📚 Kurs</span></div>
                      <div className="tile-meta">
                        <span>PW: <span className="pw-tag">{co.password}</span></span>
                        <span>🎵 {co.entries.length} Einträge</span>
                        <span>▶ {co.entries.reduce((s,e)=>s+(e.plays||0),0)} Mal gespielt</span>
                      </div>
                    </div>
                    <div className="tile-footer">
                      <button className="btn btn-purple btn-sm" onClick={()=>{setActiveCourseId(co.id);setAdminTab("queue");}}>📋 Liste</button>
                      {adminRole!=="viewer"&&<button className="btn btn-danger btn-sm" onClick={()=>deleteCourse(co.id)}>🗑 Löschen</button>}
                      <button className="tile-bg-btn" style={{marginLeft:"auto"}}
                        onClick={()=>setQrModal({name:co.name,password:co.password,type:"course"})}>
                        ⬛ QR
                      </button>
                      <label style={{cursor:"pointer"}}>
                        <span className="tile-bg-btn">🖼</span>
                        <input type="file" accept="image/*" style={{display:"none"}}
                          onChange={e=>{ if(e.target.files[0]) readImage(e.target.files[0], bg=>updateCourseBg(co.id,bg)); }}/>
                      </label>
                      {co.bg&&<button className="tile-bg-btn" onClick={()=>updateCourseBg(co.id,"")}>✕ Bild</button>}
                    </div>
                  </TileBg>
                ))}
              </div>
            </>)}

            {/* ── QUEUE TAB ────────────────────────────────────────────────── */}
            {adminTab==="queue" && (<>
              <div className="q-header-row">
                <span className="section-hd">Warteschlange</span>
                {events.map(ev=>(
                  <button key={ev.id}
                    className={`btn btn-sm ${activeEventId===ev.id?"btn-primary":"btn-ghost"}`}
                    onClick={()=>{setActiveEventId(ev.id);setActiveCourseId(null);}}>
                    {ev.status==="running"&&<span style={{color:"var(--green)"}}>●</span>} {ev.name}
                  </button>
                ))}
                {courses.map(co=>(
                  <button key={co.id}
                    className={`btn btn-sm ${activeCourseId===co.id?"btn-purple":"btn-ghost"}`}
                    onClick={()=>{setActiveCourseId(co.id);setActiveEventId(null);}}>
                    📚 {co.name}
                  </button>
                ))}
              </div>

              {/* Event queue */}
              {activeEv && !activeCourseId && (()=>{
                const pending      = activeEv.queue.filter(r=>r.status==="pending");
                const inappropriate= activeEv.queue.filter(r=>r.status==="inappropriate");
                const played       = activeEv.queue.filter(r=>r.status==="played");
                const intv = INTERVAL_MS[activeEv.interval]||INTERVAL_MS.daily;
                const msLeft = activeEv.type==="recurring"&&activeEv.status==="running"&&activeEv.startedAt
                  ? intv-(now()-activeEv.startedAt) : null;
                return (<>
                  {activeEv.status!=="running"&&(
                    <div className="notice notice-warn">
                      <span>{activeEv.status==="scheduled"?`⏰ Startet am ${fmtFull(activeEv.scheduledFor)}`:"○ Event noch nicht gestartet"}</span>
                      {activeEv.status==="idle"&&<button className="btn btn-success btn-sm" onClick={()=>startEvent(activeEv.id)}>▶ Starten</button>}
                    </div>
                  )}
                  {activeEv.status==="ended"&&<div className="notice notice-red"><span>■ Beendet {fmtFull(activeEv.endedAt)} – Archivansicht</span></div>}
                  {msLeft!==null&&(
                    <div className="countdown-banner">
                      <div><div className="banner-lbl">🔄 Reset in ({INTERVAL_LBL[activeEv.interval]})</div>
                      <div className="banner-time">{fmtCD(msLeft)}</div><div className="banner-sub">Liste wird automatisch geleert</div></div>
                      <div className="prog-track"><div className="prog-fill" style={{width:`${Math.max(0,msLeft/intv*100)}%`}}/></div>
                      {adminRole!=="viewer"&&<button className="btn btn-blue btn-sm" onClick={()=>resetCycle(activeEv.id)}>↺ Jetzt zurücksetzen</button>}
                    </div>
                  )}
                  <div className="queue-wrap">
                    <div className="sub-label">⏳ Warteschlange ({pending.length})</div>
                    {pending.length===0&&<p className="empty">Keine Wünsche</p>}
                    {pending.map((req,i)=>(
                      <div className="queue-item" key={req.id}>
                        <span className="queue-num">#{i+1}</span>
                        <div className="queue-info">
                          <div className="queue-title">{req.title}</div>
                          <div className="queue-artist">{req.artist}</div>
                        </div>
                        {(req.votes>0)&&<span className="queue-votes">▲ {req.votes}</span>}
                        <span className="queue-timer">⏱ {fmtTime(now()-req.addedAt)}</span>
                        {activeEv.status!=="ended"&&(
                          <div className="queue-actions">
                            <button className="btn btn-success btn-sm" onClick={()=>setReqStatus(activeEv.id,req.id,"played")}>✓ Gespielt</button>
                            <button className="btn btn-warn btn-sm" onClick={()=>setReqStatus(activeEv.id,req.id,"inappropriate")}>⚑ Unpassend</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {inappropriate.length>0&&(<>
                      <div className="divider"/>
                      <div className="sub-label" style={{color:"var(--red)"}}>🚫 Unpassend ({inappropriate.length})</div>
                      {inappropriate.map(req=>(
                        <div className="queue-item inappropriate" key={req.id}>
                          <span className="queue-num" style={{color:"var(--red)"}}>!</span>
                          <div className="queue-info"><div className="queue-title">{req.title}</div><div className="queue-artist">{req.artist}</div></div>
                          <span className="queue-timer">⏱ {fmtTime(now()-req.addedAt)}</span>
                          {activeEv.status!=="ended"&&<button className="btn btn-ghost btn-sm" onClick={()=>setReqStatus(activeEv.id,req.id,"pending")}>↩ Wiederherstellen</button>}
                        </div>
                      ))}
                    </>)}
                    {played.length>0&&(<>
                      <div className="divider"/>
                      <div className="sub-label" style={{color:"var(--green)"}}>✓ Gespielt ({played.length})</div>
                      {played.map(req=>(
                        <div className="queue-item played" key={req.id}>
                          <span className="queue-num" style={{color:"var(--green)"}}>✓</span>
                          <div className="queue-info"><div className="queue-title">{req.title}</div><div className="queue-artist">{req.artist}</div></div>
                        </div>
                      ))}
                    </>)}
                  </div>
                </>);
              })()}

              {/* Course list */}
              {activeCo && !activeEventId && (()=>{
                // Sort entries
                const sorted = [...activeCo.entries].sort((a,b) => {
                  if (coSort==="title-asc")   return a.title.localeCompare(b.title);
                  if (coSort==="title-desc")  return b.title.localeCompare(a.title);
                  if (coSort==="artist-asc")  return a.artist.localeCompare(b.artist);
                  if (coSort==="artist-desc") return b.artist.localeCompare(a.artist);
                  if (coSort==="plays-asc")   return (a.plays||0)-(b.plays||0);
                  if (coSort==="plays-desc")  return (b.plays||0)-(a.plays||0);
                  return 0;
                });
                return (
                <div className="queue-wrap">
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
                    <span style={{fontSize:15,fontWeight:600}}>📚 {activeCo.name}</span>
                    <span style={{fontSize:12,color:"var(--muted)"}}>
                      {activeCo.entries.length} Einträge · {activeCo.entries.reduce((s,e)=>s+(e.plays||0),0)} Mal gespielt
                    </span>
                  </div>
                  {/* Sort controls */}
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12,alignItems:"center"}}>
                    <span style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>Sortieren:</span>
                    {[["title-asc","Titel A→Z"],["title-desc","Titel Z→A"],["artist-asc","Interpret A→Z"],["artist-desc","Interpret Z→A"],["plays-desc","Plays ↓"],["plays-asc","Plays ↑"]].map(([v,l])=>(
                      <button key={v} className={`filter-btn ${coSort===v?"active":""}`} onClick={()=>setCoSort(v)}>{l}</button>
                    ))}
                  </div>
                  {activeCo.entries.length===0&&<p className="empty">Noch keine Einträge</p>}
                  <table className="course-table">
                    <thead>
                      <tr>
                        <th>#</th><th>Titel</th><th>Künstler</th><th>Name</th><th style={{textAlign:"center"}}>▶ Gespielt</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((e,i)=>(
                        <tr key={e.id}>
                          <td style={{color:"var(--muted)",fontFamily:"'Bebas Neue',sans-serif",fontSize:18}}>{i+1}</td>
                          <td style={{fontWeight:500}}>{e.title}</td>
                          <td style={{color:"var(--muted)"}}>{e.artist}</td>
                          <td style={{color:"var(--muted)"}}>{e.firstName} {e.lastName}</td>
                          <td style={{textAlign:"center"}}>
                            <div className="play-count">
                              <span className="play-badge">{e.plays||0}</span>
                              <button className="btn btn-purple btn-xs" onClick={()=>addPlayCount(activeCo.id,e.id)}>+1</button>
                            </div>
                          </td>
                          <td style={{textAlign:"right"}}>
                            {adminRole!=="viewer"&&<button className="btn btn-danger btn-xs" onClick={()=>removeEntry(activeCo.id,e.id)}>✕</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                );
              })()}

              {!activeEv&&!activeCo&&<p className="empty">Wähle ein Event oder einen Kurs aus</p>}
            </>)}

            {/* ── USERS TAB ────────────────────────────────────────────────── */}
            {adminTab==="users" && (<>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                <span className="section-hd">Benutzer ({users.length+1})</span>
              </div>
              <div className="card" style={{marginBottom:20}}>
                <div style={{fontSize:15,fontWeight:600,marginBottom:14}}>Neuen Benutzer anlegen</div>
                <div className="create-grid">
                  <div className="form-group"><div className="form-label">Benutzername</div><input className="inp" placeholder="z.B. dj_max" value={uName} onChange={e=>setUName(e.target.value)}/></div>
                  <div className="form-group"><div className="form-label">Passwort</div><input className="inp" type="password" placeholder="Passwort" value={uPw} onChange={e=>setUPw(e.target.value)}/></div>
                  <div className="form-group">
                    <div className="form-label">Rolle</div>
                    <div className="seg">
                      <button className={`seg-btn ${uRole==="dj"?"a-pink":""}`} onClick={()=>setURole("dj")}>🎛️ DJ / Admin</button>
                      <button className={`seg-btn ${uRole==="viewer"?"a-blue":""}`} onClick={()=>setURole("viewer")}>👁 Beobachter</button>
                    </div>
                  </div>
                  <div className="form-group full">
                    {uErr&&<span className="error" style={{marginBottom:6}}>{uErr}</span>}
                    <button className="btn btn-primary" style={{alignSelf:"flex-start"}} onClick={createUser}>+ Benutzer anlegen</button>
                  </div>
                </div>
              </div>
              <div className="user-list">
                {/* Superadmin row */}
                <div style={{display:"flex",flexDirection:"column",gap:0}}>
                  <div className="user-item" style={{borderRadius:changingPwId==="super"?"10px 10px 0 0":"10px"}}>
                    <span className="user-name">Superadmin</span>
                    <span className="role-badge role-dj">🔑 Superadmin</span>
                    <div style={{marginLeft:"auto",display:"flex",gap:6}}>
                      <button className="btn btn-ghost btn-xs"
                        onClick={()=>{ setChangingPwId(changingPwId==="super"?null:"super"); setNewPwVal(""); setNewPwVal2(""); setPwChangeErr(""); setPwChangeOk(false); }}>
                        {changingPwId==="super"?"✕ Abbrechen":"🔑 Passwort ändern"}
                      </button>
                    </div>
                  </div>
                  {changingPwId==="super"&&(
                    <div className="pw-change-form" style={{borderRadius:"0 0 10px 10px",borderTop:"none"}}>
                      <div className="form-label">Neues Superadmin-Passwort</div>
                      <input className="inp" type="password" placeholder="Neues Passwort" value={newPwVal} onChange={e=>setNewPwVal(e.target.value)}/>
                      <input className="inp" type="password" placeholder="Passwort wiederholen" value={newPwVal2} onChange={e=>setNewPwVal2(e.target.value)}
                        onKeyDown={e=>e.key==="Enter"&&submitPasswordChange()}/>
                      {pwChangeErr&&<span className="error">{pwChangeErr}</span>}
                      {pwChangeOk&&changingPwId==="super"&&<span className="pw-ok">✓ Passwort wurde geändert!</span>}
                      <button className="btn btn-primary btn-sm" style={{alignSelf:"flex-start"}} onClick={submitPasswordChange}>✓ Speichern</button>
                    </div>
                  )}
                </div>

                {users.length===0&&<p className="empty">Noch keine Benutzer</p>}
                {users.map(u=>(
                  <div style={{display:"flex",flexDirection:"column",gap:0}} key={u.id}>
                    <div className="user-item" style={{borderRadius:changingPwId===u.id?"10px 10px 0 0":"10px"}}>
                      <span className="user-name">👤 {u.name}</span>
                      <span className={`role-badge role-${u.role}`}>{u.role==="dj"?"🎛️ DJ / Admin":"👁 Beobachter"}</span>
                      <div style={{marginLeft:"auto",display:"flex",gap:6}}>
                        <button className="btn btn-ghost btn-xs"
                          onClick={()=>{ setChangingPwId(changingPwId===u.id?null:u.id); setNewPwVal(""); setNewPwVal2(""); setPwChangeErr(""); setPwChangeOk(false); }}>
                          {changingPwId===u.id?"✕ Abbrechen":"🔑 Passwort"}
                        </button>
                        <button className="btn btn-danger btn-xs" onClick={()=>{ deleteUser(u.id); if(changingPwId===u.id) setChangingPwId(null); }}>✕</button>
                      </div>
                    </div>
                    {changingPwId===u.id&&(
                      <div className="pw-change-form" style={{borderRadius:"0 0 10px 10px",borderTop:"none"}}>
                        <div className="form-label">Neues Passwort für {u.name}</div>
                        <input className="inp" type="password" placeholder="Neues Passwort" value={newPwVal} onChange={e=>setNewPwVal(e.target.value)}/>
                        <input className="inp" type="password" placeholder="Passwort wiederholen" value={newPwVal2} onChange={e=>setNewPwVal2(e.target.value)}
                          onKeyDown={e=>e.key==="Enter"&&submitPasswordChange()}/>
                        {pwChangeErr&&<span className="error">{pwChangeErr}</span>}
                        {pwChangeOk&&changingPwId===u.id&&<span className="pw-ok">✓ Passwort wurde geändert!</span>}
                        <button className="btn btn-primary btn-sm" style={{alignSelf:"flex-start"}} onClick={submitPasswordChange}>✓ Speichern</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>)}
          </div>
        )}

        {/* ── CUSTOMER ──────────────────────────────────────────────────────── */}
        {screen==="customer" && (custEvent||custCourse) && (()=>{
          const item = custEvent||custCourse;
          return (
            <div className="cust-wrap">
              <div className="cust-header" style={item.bg?{backgroundImage:`url(${item.bg})`}:{}}>
                {item.bg&&<div className="cust-header-overlay"/>}
                <div className="cust-header-inner">
                  <h2>{item.name}</h2>
                  <p>{custMode==="course"?"📚 Kursliste · Wunsch einreichen":"🎵 Reiche deinen Musikwunsch ein"}</p>
                </div>
              </div>

              {/* Event: status gates */}
              {custMode==="event"&&custEvent.status==="ended"&&(
                <div className="status-msg ended">■ Dieses Event wurde beendet.</div>
              )}
              {custMode==="event"&&custEvent.status!=="running"&&custEvent.status!=="ended"&&(
                <div className="status-msg warn">
                  {custEvent.status==="scheduled"
                    ?`⏰ Startet am ${fmtFull(custEvent.scheduledFor)} – bitte warte!`
                    :"⏳ Event noch nicht gestartet – bitte warte auf den DJ!"}
                </div>
              )}

              {/* Form: visible for running events OR always for courses */}
              {(custMode==="course"||(custMode==="event"&&custEvent.status==="running")) && (
                <div className="request-form">
                  <h3>🎵 {custMode==="course"?"Wunsch einreichen (Kursliste)":"Neuer Musikwunsch"}</h3>
                  {custMode==="course" && (
                    <div className="row2">
                      <div className="form-group">
                        <div className="form-label">Vorname</div>
                        <input className="inp" placeholder="Max" value={custFirst} onChange={e=>setCustFirst(e.target.value)}/>
                      </div>
                      <div className="form-group">
                        <div className="form-label">Nachname</div>
                        <input className="inp" placeholder="Mustermann" value={custLast} onChange={e=>setCustLast(e.target.value)}/>
                      </div>
                    </div>
                  )}
                  <div className="form-group"><div className="form-label">Titel</div>
                    <input className="inp" placeholder="z.B. Blinding Lights" value={custTitle} onChange={e=>setCustTitle(e.target.value)}/></div>
                  <div className="form-group"><div className="form-label">Künstler / Interpret</div>
                    <input className="inp" placeholder="z.B. The Weeknd" value={custArtist} onChange={e=>setCustArtist(e.target.value)}
                      onKeyDown={e=>e.key==="Enter"&&submitRequest()}/></div>
                  <button className="btn btn-primary" onClick={submitRequest}
                    disabled={!custTitle.trim()&&!custArtist.trim()}
                    style={{opacity:(custTitle.trim()||custArtist.trim())?1:0.4}}>
                    🎵 Wunsch einreichen
                  </button>
                  {custMsg&&<div className="success-msg">{custMsg}</div>}
                </div>
              )}

              {/* Event queue list with voting */}
              {custMode==="event"&&custEvent.status==="running"&&(
                <div>
                  <div className="sub-label">📋 Warteschlange</div>
                  <div className="queue-cust">
                    {custEvent.queue.filter(r=>r.status!=="inappropriate").length===0&&(
                      <p className="empty">Noch keine Wünsche – sei der Erste!</p>
                    )}
                    {custEvent.queue.filter(r=>r.status!=="inappropriate").map((req,i)=>(
                      <div className={`qci ${req.status==="played"?"played":""}`} key={req.id}>
                        <span className="q-num">#{i+1}</span>
                        <div className="q-info">
                          <div className="q-title">{req.title}</div>
                          <div className="q-artist">{req.artist}</div>
                        </div>
                        {req.status==="pending"&&(
                          <div className="vote-area">
                            {(req.votes>0)&&<span className="vote-count">▲ {req.votes}</span>}
                            <button
                              className={`btn-vote ${votedIds.has(req.id)?"voted":""}`}
                              onClick={()=>voteForReq(custEvent.id,req.id)}
                              disabled={votedIds.has(req.id)}
                              title={votedIds.has(req.id)?"Du hast bereits für diesen Titel gestimmt":"Für diesen Titel abstimmen"}
                            >
                              {votedIds.has(req.id) ? "✓ Abgestimmt" : "▲ Vote"}
                            </button>
                          </div>
                        )}
                        {req.status==="played"&&<span className="played-tag">✓ Gespielt</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Course entry list */}
              {custMode==="course"&&(
                <div>
                  <div className="sub-label">📋 Kursliste</div>
                  <div className="queue-cust">
                    {custCourse.entries.length===0&&<p className="empty">Noch keine Einträge</p>}
                    {custCourse.entries.map((e,i)=>(
                      <div className="qci" key={e.id}>
                        <span className="q-num">#{i+1}</span>
                        <div className="q-info">
                          <div className="q-title">{e.title}</div>
                          <div className="q-artist">{e.artist} · {e.firstName} {e.lastName}</div>
                        </div>
                        <span style={{fontSize:12,color:"var(--purple)",marginLeft:"auto",fontWeight:600}}>▶ {e.plays||0}×</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

      </div>

      {/* ── QR MODAL ──────────────────────────────────────────────────────── */}
      {qrModal && (()=>{
        const url = qrBaseUrl.trim()
          ? `${qrBaseUrl.trim()}?pw=${encodeURIComponent(qrModal.password)}`
          : `${window.location.origin}?pw=${encodeURIComponent(qrModal.password)}`;
        const download = () => {
          const wrap = qrCanvasRef.current;
          if (!wrap) return;
          const canvas = wrap.querySelector("canvas");
          if (!canvas) return;
          const a = document.createElement("a");
          a.download = "QR-" + qrModal.name.replace(/\s+/g, "-") + ".png";
          a.href = canvas.toDataURL("image/png");
          a.click();
        };
        const copy = () => { navigator.clipboard.writeText(url).catch(()=>{}); };
        return (
          <div className="qr-overlay" onClick={()=>setQrModal(null)}>
            <div className="qr-modal" onClick={e=>e.stopPropagation()}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <h3>⬛ QR-Code</h3>
                  <div style={{fontSize:13,color:"var(--muted)",marginTop:2}}>
                    {qrModal.type==="course"?"📚":"📋"} {qrModal.name}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={()=>setQrModal(null)}>✕</button>
              </div>

              {/* Base URL input */}
              <div>
                <div className="form-label">Basis-URL deiner App</div>
                <input className="inp" placeholder="https://deine-app.vercel.app"
                  value={qrBaseUrl} onChange={e=>setQrBaseUrl(e.target.value)}
                  style={{marginTop:4}}/>
                <div className="hint">Leer lassen = aktuelle URL wird verwendet</div>
              </div>

              {/* QR canvas */}
              <div className="qr-canvas-wrap">
                <canvas ref={qrCanvasRef}/>
              </div>

              {/* Generated URL */}
              <div>
                <div className="form-label">Generierter Link</div>
                <div className="qr-url">{url}</div>
              </div>

              {/* Actions */}
              <div className="qr-actions">
                <button className="btn btn-primary btn-sm" onClick={download}>⬇ PNG herunterladen</button>
                <button className="btn btn-ghost btn-sm" onClick={copy}>📋 Link kopieren</button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

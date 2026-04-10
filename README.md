# BQueue – Deployment-Anleitung

## Was du brauchst (alles kostenlos)

- **github.com** – Konto erstellen
- **vercel.com** – Konto erstellen (am einfachsten mit dem GitHub-Login)

---

## Schritt 1 – Repository auf GitHub erstellen

1. Gehe auf **github.com** und logge dich ein
2. Klicke oben rechts auf **„+"** → **„New repository"**
3. Name: `bqueue` (oder beliebig)
4. Sichtbarkeit: **Private** (empfohlen)
5. Klicke **„Create repository"**

---

## Schritt 2 – Dateien hochladen

Du hast zwei Möglichkeiten:

### Option A – Direkt im Browser (einfachster Weg)
1. Öffne dein neues Repository auf GitHub
2. Klicke auf **„uploading an existing file"**
3. Lade **alle Dateien aus diesem ZIP** hoch (Ordnerstruktur beibehalten)
4. Klicke **„Commit changes"**

### Option B – Mit GitHub Desktop (empfohlen für spätere Updates)
1. Lade **GitHub Desktop** herunter: desktop.github.com
2. Installieren und mit deinem GitHub-Konto verbinden
3. „Clone a repository" → dein `bqueue`-Repository auswählen
4. Dateien aus dem ZIP in den lokalen Ordner kopieren
5. In GitHub Desktop: Commit-Nachricht eingeben → **„Commit to main"** → **„Push origin"**

---

## Schritt 3 – Mit Vercel verbinden

1. Gehe auf **vercel.com** und logge dich mit GitHub ein
2. Klicke auf **„Add New Project"**
3. Wähle dein `bqueue`-Repository aus
4. Vercel erkennt automatisch, dass es ein **Vite/React**-Projekt ist
5. Klicke **„Deploy"**

→ Nach ca. 1 Minute bekommst du eine URL wie `bqueue.vercel.app`

---

## Schritt 4 – App testen

1. Öffne die Vercel-URL
2. Logge dich als Admin ein (ohne Benutzername, Passwort: `Beuss31608`)
3. Erstelle ein Test-Event und teste den Gästezugang

---

## Spätere Updates (wenn du Änderungen möchtest)

1. Bringe den Code zu Claude (claude.ai) und beschreibe die gewünschte Änderung
2. Claude liefert die aktualisierte Datei
3. Ersetze `src/App.jsx` in deinem Repository durch die neue Version
4. **Vercel deployed automatisch** innerhalb von ~1 Minute

### Mit GitHub Desktop:
1. Neue `App.jsx` in den lokalen Ordner kopieren (alte ersetzen)
2. GitHub Desktop öffnen → Commit → Push
3. Fertig

---

## Hinweise

- **Daten:** Die App speichert alle Daten im Browser (localStorage). Das bedeutet, Daten sind gerätegebunden. Wenn du von mehreren Geräten zugreifen möchtest, ist eine Supabase-Datenbank der nächste Schritt – das können wir jederzeit nachrüsten.

- **Eigene Domain:** In Vercel kannst du unter „Settings → Domains" eine eigene Domain hinterlegen (z. B. `bqueue.de`). Die Domain kaufst du separat bei einem Anbieter wie IONOS, Strato oder Namecheap (~10–15 €/Jahr).

- **QR-Codes:** Sobald die App online ist, trage die Vercel-URL in den QR-Generator ein, um korrekte Links zu erzeugen.

---

## Projektstruktur

```
bqueue/
├── index.html          ← Einstiegspunkt
├── package.json        ← Abhängigkeiten
├── vite.config.js      ← Build-Konfiguration
├── .gitignore
├── public/
│   └── favicon.svg     ← App-Icon
└── src/
    ├── main.jsx        ← React-Einstieg
    └── App.jsx         ← Gesamte App
```

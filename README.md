# Daily Rate — setup guide

Four files run the whole thing: `index.html`, `styles.css`, `app.js`, `firebase-config.js`.
No build step, no npm, no framework. Firebase loads from a CDN.

---

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project**. Name it anything. Turn Google Analytics **off** (you don't need it).
2. On the project home, click the **web icon `</>`** to register a web app. Nickname it anything. **Do not** tick Firebase Hosting yet.
3. It shows you a `firebaseConfig` object. Copy those six values into `firebase-config.js`, replacing every `PASTE_HERE`.

These values are public by design — they end up in the browser no matter what. Your protection is the security rules in step 3, not hiding this config.

## 2. Turn on Authentication (the admin login)

1. Left sidebar → **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Email/Password** → enable the first toggle → Save.
3. **Users** tab → **Add user**. Enter the admin's email and a password. This is the only account that will ever exist — there is no signup screen in the app, which is exactly what you want.

## 3. Turn on Firestore (where the parameters live)

1. Left sidebar → **Build → Firestore Database → Create database**.
2. Pick **production mode** (not test mode — test mode lets anyone on the internet overwrite your rates).
3. Location: `asia-south1` (Mumbai) is closest to Karachi.
4. Once created, go to the **Rules** tab, delete what's there, paste the contents of `firestore.rules`, and click **Publish**.

You do **not** need to create the `settings/daily` document by hand. The first time the admin hits **Confirm**, it creates itself.

## 4. Run it locally

Because the app uses JavaScript modules, opening `index.html` by double-clicking will **not** work — the browser blocks module imports on `file://`. You need a local server. Pick one:

```bash
# Python (already on most machines)
cd rate-app
python3 -m http.server 5500
# then open http://localhost:5500

# or Node
npx serve .

# or VS Code: install the "Live Server" extension, right-click index.html → Open with Live Server
```

First run: click **Admin** (top right) → sign in. The admin menu provides **Set material prices** and **View factory prices**. The public calculator shows only the minimum-to-maximum shop range. It adds 10% and 25% to the calculated internal rate. For example, an internal rate of Rs 1,000 displays as Rs 1,100 to Rs 1,250. The factory rate can be viewed only through the authenticated admin option.

## 5. Put it online

```bash
npm install -g firebase-tools
firebase login
cd rate-app
firebase init hosting
#   - "Use an existing project" → pick yours
#   - public directory: .        (a dot — your files are in the root)
#   - single-page app: No
#   - overwrite index.html: NO   ← say no, this matters
firebase deploy
```

You get a URL like `https://your-project.web.app`. That's the link you send to users. Free tier covers this workload many times over.

**Custom domain** (optional): Hosting → Add custom domain, then add the DNS records it gives you.

## 6. Tell users to save it to their home screen

This is the part that decides whether they actually use it daily:

- **Android/Chrome:** open the link → ⋮ menu → *Add to Home screen*
- **iPhone/Safari:** open the link → share icon → *Add to Home Screen*

It then looks and opens like an app icon. Worth putting two screenshots of this in a WhatsApp message to them.

---

## Changing the formula

Top of `app.js`, the `calculateRate` function. Right now it's a placeholder:

```js
rate = a·wires·core + b·mm·thousands + c·(wires + mm) + d
```

Change that one function, redeploy, done. Nothing else touches the formula.

## Adding or changing parameters

If you later need `e`:
1. Add an `<input id="in-e">` block in the admin `grid2` section of `index.html`.
2. Add `e: parseFloat($("in-e").value)` in the confirm handler and `$("in-e").value = p.e ?? ""` in `loadAdminPanel`.
3. Use `p.e` in `calculateRate`.

## Things worth knowing

- **The parameters are global, not per-day-history.** Confirm overwrites the single `settings/daily` document. If you ever need to look back at what yesterday's numbers were, that history doesn't exist — say so now and I'll switch it to one document per date.
- **If the admin forgets to set parameters,** clients see "Today's rate is not set yet." The old values do *not* silently persist as new — actually they do, since the doc isn't cleared at midnight. If you want stale rates to be rejected, that's a check against `updatedAt`; ask and I'll add it.
- **Password reset:** there's no reset screen. Change the admin password from Firebase Console → Authentication → Users → ⋮ → Reset password.

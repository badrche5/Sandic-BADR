// Cloud layer: Firebase Auth + Firestore (per-user data, offline cache, daily backups).
// Loaded as an ES module. Exposes window.cloud and fires "cloud-ready".
// If firebase-config.js is missing/placeholder, window.cloud.enabled === false and the app runs local-only.
const V = '10.14.1';
const CDN = `https://www.gstatic.com/firebasejs/${V}/`;
const cfg = window.FIREBASE_CONFIG;
const configured = !!(cfg && cfg.apiKey && !/YOUR_|PASTE_/i.test(cfg.apiKey) && cfg.projectId);

function disabled(reason) {
  window.cloud = { enabled: false, reason };
  window.dispatchEvent(new CustomEvent('cloud-ready'));
}

if (!configured) {
  disabled('not-configured');
} else {
  try {
    const [appM, authM, fsM] = await Promise.all([
      import(CDN + 'firebase-app.js'),
      import(CDN + 'firebase-auth.js'),
      import(CDN + 'firebase-firestore.js'),
    ]);
    const app = appM.initializeApp(cfg);
    const auth = authM.initializeAuth(app, {
      persistence: [authM.indexedDBLocalPersistence, authM.browserLocalPersistence],
      popupRedirectResolver: authM.browserPopupRedirectResolver,
    });
    try { auth.languageCode = (document.documentElement.lang || 'ar'); } catch (e) {}
    const fsOpts = {
      localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }),
    };
    let db;
    try {
      db = cfg.firestoreDatabaseId
        ? fsM.initializeFirestore(app, fsOpts, cfg.firestoreDatabaseId)
        : fsM.initializeFirestore(app, fsOpts);
    } catch (e) {
      // persistence unsupported (private mode etc.) → memory cache
      db = cfg.firestoreDatabaseId ? fsM.getFirestore(app, cfg.firestoreDatabaseId) : fsM.getFirestore(app);
    }

    const mainRef = (uid) => fsM.doc(db, 'users', uid);
    const bkRef = (uid, id) => fsM.doc(db, 'users', uid, 'backups', id);
    const uidOrThrow = () => { if (!auth.currentUser) throw new Error('not-signed-in'); return auth.currentUser.uid; };
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    const cloud = {
      enabled: true,
      user: () => auth.currentUser,
      onAuth: (cb) => authM.onAuthStateChanged(auth, cb),
      signUp: async (email, pw) => {
        const c = await authM.createUserWithEmailAndPassword(auth, email, pw);
        try { await authM.sendEmailVerification(c.user); } catch (e) {}
        return c.user;
      },
      signIn: async (email, pw) => (await authM.signInWithEmailAndPassword(auth, email, pw)).user,
      google: async () => {
        const p = new authM.GoogleAuthProvider();
        try { return (await authM.signInWithPopup(auth, p)).user; }
        catch (e) {
          if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
            await authM.signInWithRedirect(auth, p); return null;
          }
          throw e;
        }
      },
      redirectResult: async () => { try { return await authM.getRedirectResult(auth); } catch (e) { return null; } },
      resetPassword: (email) => authM.sendPasswordResetEmail(auth, email),
      resendVerification: () => authM.sendEmailVerification(auth.currentUser),
      reloadUser: async () => { await auth.currentUser.reload(); return auth.currentUser; },
      signOut: () => authM.signOut(auth),
      providerIds: () => (auth.currentUser ? auth.currentUser.providerData.map((p) => p.providerId) : []),
      reauth: async (pw) => {
        const u = auth.currentUser;
        if (pw != null) return authM.reauthenticateWithCredential(u, authM.EmailAuthProvider.credential(u.email, pw));
        return authM.reauthenticateWithPopup(u, new authM.GoogleAuthProvider());
      },

      // ---- data ----
      load: async () => {
        const s = await fsM.getDoc(mainRef(uidOrThrow()));
        return s.exists() ? s.data() : null;
      },
      save: (payload) => fsM.setDoc(mainRef(uidOrThrow()), payload),
      watch: (cb) => {
        const uid = uidOrThrow();
        return fsM.onSnapshot(mainRef(uid), { includeMetadataChanges: false }, (snap) => {
          cb(snap.exists() ? snap.data() : null, snap.metadata.hasPendingWrites, snap.metadata.fromCache);
        }, () => {});
      },
      flush: (ms = 6000) => withTimeout(fsM.waitForPendingWrites(db), ms),
      writeBackup: (id, payload) => fsM.setDoc(bkRef(uidOrThrow(), id), payload),
      deleteBackup: (id) => fsM.deleteDoc(bkRef(uidOrThrow(), id)),
      listBackups: async () => {
        const snap = await fsM.getDocs(fsM.collection(db, 'users', uidOrThrow(), 'backups'));
        const out = []; snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
        return out.sort((a, b) => (a.id < b.id ? 1 : -1));
      },
      deleteAccount: async () => {
        const u = auth.currentUser; const uid = u.uid;
        // data first (rules need the signed-in user), then the account itself
        const snap = await fsM.getDocs(fsM.collection(db, 'users', uid, 'backups'));
        const jobs = []; snap.forEach((d) => jobs.push(fsM.deleteDoc(d.ref)));
        await Promise.all(jobs);
        await fsM.deleteDoc(mainRef(uid));
        await authM.deleteUser(u);
      },
    };
    window.cloud = cloud;
    window.dispatchEvent(new CustomEvent('cloud-ready'));
  } catch (e) {
    console.warn('Cloud init failed', e);
    disabled('init-failed');
  }
}

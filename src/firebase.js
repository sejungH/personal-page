import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const firebaseReady = Object.values(firebaseConfig).every(Boolean);

let app = null;
let auth = null;
let db = null;
let storage = null;
let provider = null;
let redirectResultPromise = Promise.resolve(null);
let redirectResultError = null;

if (firebaseReady) {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
  provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  // Complete pending redirect sign-in as early as possible so auth state is restored reliably.
  redirectResultPromise = getRedirectResult(auth).catch((error) => {
    redirectResultError = error;
    return null;
  });
} else {
  console.warn("Firebase 환경 변수가 비어 있어 앱이 읽기 전용 안내 모드로 동작합니다.");
}

function shouldFallbackToRedirect(error) {
  const code = String(error?.code || "");
  return (
    code === "auth/operation-not-supported-in-this-environment"
  );
}

async function signInWithGoogle() {
  if (!auth || !provider) {
    throw new Error("Firebase 인증 설정이 없습니다.");
  }

  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (!shouldFallbackToRedirect(error)) {
      throw error;
    }

    await signInWithRedirect(auth, provider);
  }
}

async function waitForRedirectResult() {
  await redirectResultPromise;
  return redirectResultError;
}

export { auth, db, storage, provider, firebaseReady, signInWithGoogle, waitForRedirectResult };

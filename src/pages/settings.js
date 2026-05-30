import "../style.css";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db, firebaseReady, signInWithGoogle } from "../firebase";
import {
  getTopbarRefs,
  initTopbarTheme,
  renderTopbar,
  renderTopbarAuth,
  wireTopbarEvents,
} from "../shared/topbar";

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="aurora one"></div>
  <div class="aurora two"></div>

  <div class="page-shell">
    ${renderTopbar("설정")}

    <section class="panel page-panel">
      <div class="panel-head">
        <h2><i class="fa-solid fa-gear h2-icon" aria-hidden="true"></i>설정</h2>
        <span class="hint">프로필 관리</span>
      </div>

      <p id="status" class="notice info">로그인 상태를 확인 중입니다...</p>

      <form id="profileForm" class="stack hidden">
        <input id="nicknameInput" type="text" maxlength="20" placeholder="닉네임 (2~20자)" required />
        <button class="btn primary" type="submit">닉네임 저장</button>
      </form>

      <p id="meta" class="meta-text hidden"></p>
    </section>
  </div>
`;

const refs = {
  ...getTopbarRefs(),
  status: document.querySelector("#status"),
  profileForm: document.querySelector("#profileForm"),
  nicknameInput: document.querySelector("#nicknameInput"),
  meta: document.querySelector("#meta"),
};

const state = {
  user: null,
  isAdmin: false,
  createdAt: null,
};

initTopbarTheme(refs);
wireTopbarEvents({
  refs,
  onLoginRequested: async () => {
    if (!firebaseReady) return;

    try {
      await signInWithGoogle();
    } catch (error) {
      refs.status.textContent = `로그인 실패: ${error.message}`;
      refs.status.className = "notice error";
    }
  },
});
renderTopbarAuth({ refs, user: null, isAdmin: false, userName: "" });

if (!firebaseReady) {
  refs.status.textContent = "Firebase 설정이 없습니다. .env를 확인해 주세요.";
  refs.status.className = "notice warn";
} else {
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    state.isAdmin = false;

    renderTopbarAuth({ refs, user, isAdmin: false, userName: user?.displayName || user?.email || "" });

    if (!user) {
      refs.status.textContent = "로그인이 필요합니다. 홈으로 돌아가 로그인해 주세요.";
      refs.status.className = "notice warn";
      refs.profileForm.classList.add("hidden");
      refs.meta.classList.add("hidden");
      return;
    }

    state.isAdmin = await resolveAdminRole(user);

    const profileSnapshot = await getDoc(doc(db, "users", user.uid));
    let headerUserName = user.displayName || user.email || "";

    if (profileSnapshot.exists()) {
      const profile = profileSnapshot.data();
      const nickname = String(profile.nickname || "").trim();
      refs.nicknameInput.value = nickname;
      state.createdAt = profile.createdAt || null;

      if (nickname.length >= 2) {
        headerUserName = nickname;
      }
    } else {
      refs.nicknameInput.value = String(user.displayName || "").trim().slice(0, 20);
      state.createdAt = null;
    }

    renderTopbarAuth({ refs, user, isAdmin: state.isAdmin, userName: headerUserName });

    refs.profileForm.classList.remove("hidden");
    refs.meta.classList.remove("hidden");
    refs.meta.textContent = `이메일: ${user.email || "-"} / 역할: ${state.isAdmin ? "어드민" : "일반 사용자"}`;
    refs.status.textContent = "닉네임을 수정할 수 있습니다.";
    refs.status.className = "notice success";
  });
}

refs.profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!state.user) return;

  const nickname = refs.nicknameInput.value.trim();
  if (nickname.length < 2 || nickname.length > 20) {
    refs.status.textContent = "닉네임은 2자 이상 20자 이하로 입력해 주세요.";
    refs.status.className = "notice warn";
    return;
  }

  try {
    await setDoc(
      doc(db, "users", state.user.uid),
      {
        uid: state.user.uid,
        email: state.user.email || "",
        photoURL: state.user.photoURL || "",
        nickname,
        createdAt: state.createdAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
      },
      { merge: true }
    );

    renderTopbarAuth({
      refs,
      user: state.user,
      isAdmin: state.isAdmin,
      userName: nickname,
    });

    refs.status.textContent = "닉네임이 저장되었습니다.";
    refs.status.className = "notice success";
  } catch (error) {
    refs.status.textContent = `저장 실패: ${error.message}`;
    refs.status.className = "notice error";
  }
});

async function resolveAdminRole(user) {
  try {
    const roleSnapshot = await getDoc(doc(db, "settings", "roles"));
    const email = String(user.email || "").toLowerCase();
    const admins = roleSnapshot.exists() && Array.isArray(roleSnapshot.data().admins)
      ? roleSnapshot.data().admins.map((value) => String(value).trim().toLowerCase())
      : [];

    return admins.includes(email);
  } catch {
    return false;
  }
}

import "../style.css";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, firebaseReady, signInWithGoogle } from "../firebase";
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
    ${renderTopbar("로그아웃")}

    <section class="panel page-panel">
      <div class="panel-head">
        <h2><i class="fa-solid fa-right-from-bracket h2-icon" aria-hidden="true"></i>로그아웃</h2>
        <span class="hint">세션 종료</span>
      </div>

      <p id="status" class="notice info">로그아웃 처리 중입니다...</p>
    </section>
  </div>
`;

const topbarRefs = getTopbarRefs();
const statusEl = document.querySelector("#status");
let processed = false;

initTopbarTheme(topbarRefs);
wireTopbarEvents({
  refs: topbarRefs,
  onLoginRequested: async () => {
    if (!firebaseReady) return;

    try {
      await signInWithGoogle();
    } catch (error) {
      statusEl.textContent = `로그인 실패: ${error.message}`;
      statusEl.className = "notice error";
    }
  },
});
renderTopbarAuth({ refs: topbarRefs, user: null, isAdmin: false, userName: "" });

if (!firebaseReady) {
  statusEl.textContent = "Firebase 설정이 없어 로그아웃 처리를 건너뜁니다.";
  statusEl.className = "notice warn";
} else {
  onAuthStateChanged(auth, async (user) => {
    renderTopbarAuth({
      refs: topbarRefs,
      user,
      isAdmin: false,
      userName: user?.displayName || user?.email || "",
    });

    if (processed) return;

    if (!user) {
      processed = true;
      statusEl.textContent = "이미 로그아웃 상태입니다.";
      statusEl.className = "notice success";
      return;
    }

    try {
      await signOut(auth);
      processed = true;
      statusEl.textContent = "로그아웃되었습니다.";
      statusEl.className = "notice success";
    } catch (error) {
      processed = true;
      statusEl.textContent = `로그아웃 실패: ${error.message}`;
      statusEl.className = "notice error";
    }
  });
}

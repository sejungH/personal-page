const FALLBACK_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><rect width='48' height='48' rx='24' fill='#d8d8df'/><circle cx='24' cy='18' r='8' fill='#999aa8'/><path d='M10 40c2.8-6.6 8.5-10 14-10s11.2 3.4 14 10' fill='#999aa8'/></svg>"
)}`;

export function renderTopbar(title) {
  return `
    <header class="topbar panel">
      <div class="topbar-start">
        <a href="/" class="home-shortcut" aria-label="홈으로 이동" title="홈으로 이동">
          <i class="fa-solid fa-house" aria-hidden="true"></i>
        </a>
        <div class="brand-block">
          <p class="eyebrow">MY PERSONAL BOARD</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
      </div>

      <div class="toolbar">
        <button id="themeToggle" class="chip" type="button" aria-label="다크 모드로 전환" title="다크 모드로 전환">
          <i class="fa-solid fa-moon" aria-hidden="true"></i>
        </button>
        <button id="loginBtn" class="chip accent" type="button">Google 로그인</button>

        <div id="userCard" class="user-card hidden" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">
          <img id="userAvatar" alt="프로필" />
          <div>
            <strong id="userName"></strong>
            <p id="roleBadge"></p>
          </div>

          <div id="userDropdown" class="user-dropdown hidden">
            <a id="adminPageLink" href="/admin.html" class="dropdown-item hidden"><i class="fa-solid fa-user-shield" aria-hidden="true"></i>어드민</a>
            <a id="myActivityLink" href="/user.html" class="dropdown-item"><i class="fa-solid fa-file-lines" aria-hidden="true"></i>내가 쓴 글/댓글</a>
            <a href="/settings.html" class="dropdown-item"><i class="fa-solid fa-gear" aria-hidden="true"></i>설정</a>
            <a href="/logout.html" class="dropdown-item"><i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>로그아웃</a>
          </div>
        </div>
      </div>
    </header>
  `;
}

export function getTopbarRefs(root = document) {
  return {
    themeToggle: root.querySelector("#themeToggle"),
    loginBtn: root.querySelector("#loginBtn"),
    userCard: root.querySelector("#userCard"),
    userDropdown: root.querySelector("#userDropdown"),
    adminPageLink: root.querySelector("#adminPageLink"),
    myActivityLink: root.querySelector("#myActivityLink"),
    userAvatar: root.querySelector("#userAvatar"),
    userName: root.querySelector("#userName"),
    roleBadge: root.querySelector("#roleBadge"),
  };
}

export function wireTopbarEvents({ refs, onLoginRequested }) {
  refs.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || "light";
    applyTheme(refs, current === "light" ? "dark" : "light");
  });

  refs.loginBtn.addEventListener("click", async () => {
    if (typeof onLoginRequested !== "function") return;
    await onLoginRequested();
  });

  refs.userCard.addEventListener("click", (event) => {
    if (refs.userCard.classList.contains("hidden")) return;
    if (event.target.closest("#userDropdown")) return;
    event.stopPropagation();
    setTopbarDropdownVisible(refs, refs.userDropdown.classList.contains("hidden"));
  });

  refs.userCard.addEventListener("keydown", (event) => {
    if (refs.userCard.classList.contains("hidden")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest("#userDropdown")) return;
    event.preventDefault();
    setTopbarDropdownVisible(refs, refs.userDropdown.classList.contains("hidden"));
  });

  document.addEventListener("click", (event) => {
    if (refs.userDropdown.classList.contains("hidden")) return;
    if (!refs.userCard.contains(event.target)) {
      setTopbarDropdownVisible(refs, false);
    }
  });
}

export function initTopbarTheme(refs) {
  const saved = localStorage.getItem("theme");
  applyTheme(refs, saved || "light");
}

export function renderTopbarAuth({ refs, user, isAdmin, userName }) {
  const isLoggedIn = Boolean(user);

  refs.loginBtn.classList.toggle("hidden", isLoggedIn);
  refs.userCard.classList.toggle("hidden", !isLoggedIn);
  setTopbarDropdownVisible(refs, false);

  if (!isLoggedIn) {
    refs.userAvatar.src = FALLBACK_AVATAR;
    refs.userAvatar.onerror = null;
    refs.userName.textContent = "";
    refs.roleBadge.textContent = "";
    refs.roleBadge.classList.add("hidden");
    refs.adminPageLink.classList.add("hidden");
    refs.myActivityLink.href = "/user.html";
    return;
  }

  setAvatarImage(refs, user.photoURL);
  refs.userName.textContent = userName || user.displayName || user.email || "사용자";
  refs.roleBadge.textContent = isAdmin ? "어드민" : "";
  refs.roleBadge.classList.toggle("hidden", !isAdmin);
  refs.adminPageLink.classList.toggle("hidden", !isAdmin);
  refs.myActivityLink.href = `/user.html?uid=${encodeURIComponent(user.uid)}`;
}

function setAvatarImage(refs, photoURL) {
  const normalized = normalizeAvatarUrl(photoURL);
  refs.userAvatar.referrerPolicy = "no-referrer";
  refs.userAvatar.decoding = "async";
  refs.userAvatar.loading = "eager";
  refs.userAvatar.onerror = () => {
    refs.userAvatar.onerror = null;
    refs.userAvatar.src = FALLBACK_AVATAR;
  };
  refs.userAvatar.src = normalized || FALLBACK_AVATAR;
}

function normalizeAvatarUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  return value;
}

export function setTopbarDropdownVisible(refs, visible) {
  refs.userDropdown.classList.toggle("hidden", !visible);
  refs.userCard.setAttribute("aria-expanded", visible ? "true" : "false");
}

function applyTheme(refs, theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);

  const toDark = theme === "light";
  refs.themeToggle.innerHTML = toDark
    ? '<i class="fa-solid fa-moon" aria-hidden="true"></i>'
    : '<i class="fa-solid fa-sun" aria-hidden="true"></i>';
  refs.themeToggle.setAttribute("aria-label", toDark ? "다크 모드로 전환" : "라이트 모드로 전환");
  refs.themeToggle.title = toDark ? "다크 모드로 전환" : "라이트 모드로 전환";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

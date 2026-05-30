import "../style.css";
import "quill/dist/quill.snow.css";
import Quill from "quill";
import { onAuthStateChanged } from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getDownloadURL, ref as storageRef, uploadBytes } from "firebase/storage";
import { auth, db, firebaseReady, signInWithGoogle, storage } from "../firebase";
import {
  getTopbarRefs,
  initTopbarTheme,
  renderTopbar,
  renderTopbarAuth,
  wireTopbarEvents,
} from "../shared/topbar";

const params = new URLSearchParams(window.location.search);
const initialBoardId = params.get("boardId");

const state = {
  user: null,
  isAdmin: false,
  userProfile: null,
  needsNickname: false,
  boards: [],
  selectedBoardId: initialBoardId,
  editor: null,
};

let unsubscribeBoards = null;

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="aurora one"></div>
  <div class="aurora two"></div>

  <div class="shell">
    ${renderTopbar("새 글 작성")}

    <p id="globalNotice" class="notice info">글쓰기 화면을 준비 중입니다...</p>

    <main class="grid main-grid">
      <section class="panel col boards">
        <div class="panel-head">
          <h2><i class="fa-solid fa-table-columns h2-icon" aria-hidden="true"></i>게시판</h2>
          <span class="hint">작성할 게시판 선택</span>
        </div>

        <ul id="boardList" class="board-list"></ul>
      </section>

      <section class="panel col posts">
        <div class="panel-head">
          <h2><i class="fa-solid fa-pen-to-square h2-icon" aria-hidden="true"></i>글 작성</h2>
        </div>

        <form id="writeForm" class="stack hidden">
          <input id="postTitle" type="text" maxlength="80" placeholder="제목" required />
          <div class="rich-editor-shell">
            <div id="postEditor" class="rich-editor"></div>
          </div>
          <button class="btn primary" type="submit">등록하기</button>
        </form>

        <p id="writeBlocked" class="notice subtle hidden"></p>
      </section>
    </main>
  </div>
`;

const refs = {
  ...getTopbarRefs(),
  globalNotice: document.querySelector("#globalNotice"),
  boardList: document.querySelector("#boardList"),
  writeForm: document.querySelector("#writeForm"),
  postTitle: document.querySelector("#postTitle"),
  postEditor: document.querySelector("#postEditor"),
  writeBlocked: document.querySelector("#writeBlocked"),
};

initTopbarTheme(refs);
initEditor();
wireEvents();
renderAll();

if (firebaseReady) {
  startAuthFlow();
  listenBoards();
  setNotice("작성할 게시판을 선택한 뒤 글을 등록하세요.", "success");
} else {
  setNotice(".env 파일에 Firebase 정보를 채우면 작성 기능이 활성화됩니다.", "warn");
}

function wireEvents() {
  wireTopbarEvents({
    refs,
    onLoginRequested: async () => {
      if (!firebaseReady) return;
      try {
        await signInWithGoogle();
      } catch (error) {
        setNotice(`로그인 실패: ${error.message}`, "error");
      }
    },
  });

  refs.boardList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-board-id]");
    if (!button) return;

    state.selectedBoardId = button.dataset.boardId;
    renderBoards();
    renderWriteState();
  });

  refs.writeForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!canCurrentUserWritePost()) {
      setNotice("현재 게시판에는 글 작성 권한이 없습니다.", "warn");
      return;
    }

    const board = selectedBoard();
    if (!board) {
      setNotice("게시판을 먼저 선택해 주세요.", "warn");
      return;
    }

    const title = refs.postTitle.value.trim();
    const content = state.editor?.root.innerHTML || "";
    const plainText = state.editor?.getText().trim() || "";

    if (!title || !plainText) return;

    try {
      const result = await addDoc(collection(db, "posts"), {
        boardId: board.id,
        title,
        content,
        authorUid: state.user.uid,
        authorName: currentUserName(),
        authorPhotoURL: state.user.photoURL || "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      window.location.href = `/post.html?boardId=${encodeURIComponent(board.id)}&postId=${encodeURIComponent(result.id)}`;
    } catch (error) {
      setNotice(`게시글 등록 실패: ${error.message}`, "error");
    }
  });
}

function initEditor() {
  state.editor = new Quill(refs.postEditor, {
    theme: "snow",
    placeholder: "내용을 입력하세요",
    modules: {
      toolbar: {
        container: [
          [{ header: [1, 2, false] }],
          ["bold", "italic", "underline", "strike"],
          [{ list: "ordered" }, { list: "bullet" }],
          ["blockquote", "code-block"],
          ["link", "image"],
          ["clean"],
        ],
        handlers: {
          image: handleEditorImageInsert,
        },
      },
    },
  });
}

function handleEditorImageInsert() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.click();

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    if (!state.user) {
      setNotice("이미지 업로드를 위해 로그인해 주세요.", "warn");
      return;
    }

    if (!storage) {
      setNotice("이미지 업로드를 위한 Storage 설정이 없습니다.", "error");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setNotice("이미지는 10MB 이하만 업로드할 수 있습니다.", "warn");
      return;
    }

    try {
      setNotice("이미지 업로드 중입니다...", "info");

      const safeName = String(file.name || "image")
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9._-]/g, "");
      const path = `post-images/${state.user.uid}/${Date.now()}-${safeName}`;
      const uploadedRef = storageRef(storage, path);

      await uploadBytes(uploadedRef, file);
      const url = await getDownloadURL(uploadedRef);

      const range = state.editor.getSelection(true);
      state.editor.insertEmbed(range.index, "image", url, "user");
      state.editor.setSelection(range.index + 1, 0, "silent");

      setNotice("이미지 업로드가 완료되었습니다.", "success");
    } catch (error) {
      setNotice(`이미지 업로드 실패: ${error.message}`, "error");
    }
  });
}

function startAuthFlow() {
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    state.isAdmin = false;
    state.userProfile = null;
    state.needsNickname = false;

    if (user) {
      state.isAdmin = await resolveAdminRole(user);
      await syncCurrentUserProfile(user);
    }

    renderAuth();
    renderWriteState();
  });
}

async function syncCurrentUserProfile(user) {
  try {
    const profileRef = doc(db, "users", user.uid);
    const profileSnapshot = await getDoc(profileRef);

    if (!profileSnapshot.exists()) {
      state.userProfile = null;
      state.needsNickname = true;
      return;
    }

    state.userProfile = { id: profileSnapshot.id, ...profileSnapshot.data() };
    const nickname = String(state.userProfile.nickname || "").trim();
    state.needsNickname = nickname.length < 2;

    await setDoc(
      profileRef,
      {
        email: user.email || "",
        photoURL: user.photoURL || "",
        lastLoginAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error("유저 프로필 동기화 실패", error);
  }
}

async function resolveAdminRole(user) {
  const email = String(user?.email || "").toLowerCase();

  try {
    const roleSnapshot = await getDoc(doc(db, "settings", "roles"));
    if (!roleSnapshot.exists()) return false;

    const admins = Array.isArray(roleSnapshot.data().admins)
      ? roleSnapshot.data().admins.map((value) => String(value).trim().toLowerCase())
      : [];

    return admins.includes(email);
  } catch {
    return false;
  }
}

function listenBoards() {
  unsubscribeBoards?.();

  const boardQuery = collection(db, "boards");
  unsubscribeBoards = onSnapshot(
    boardQuery,
    (snapshot) => {
      state.boards = sortBoards(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));

      if (!state.selectedBoardId || !state.boards.some((board) => board.id === state.selectedBoardId)) {
        state.selectedBoardId = state.boards[0]?.id || null;
      }

      renderBoards();
      renderWriteState();
    },
    (error) => setNotice(`게시판 조회 실패: ${error.message}`, "error")
  );
}

function renderAll() {
  renderAuth();
  renderBoards();
  renderWriteState();
}

function renderAuth() {
  renderTopbarAuth({
    refs,
    user: state.user,
    isAdmin: state.isAdmin,
    userName: currentUserName(),
  });
}

function renderBoards() {
  if (!state.boards.length) {
    refs.boardList.innerHTML = `<li class="empty-card">게시판이 없습니다.</li>`;
    return;
  }

  refs.boardList.innerHTML = state.boards
    .map((board) => {
      const selected = board.id === state.selectedBoardId;

      return `
        <li>
          <button class="board-item ${selected ? "active" : ""}" data-board-id="${escapeHtml(board.id)}" type="button">
            <div>
              <strong>${escapeHtml(board.name || "이름 없는 게시판")}</strong>
              <p>${escapeHtml(board.description || "설명 없음")}</p>
            </div>
          </button>
        </li>
      `;
    })
    .join("");
}

function renderWriteState() {
  const board = selectedBoard();

  if (!board) {
    refs.writeForm.classList.add("hidden");
    refs.writeBlocked.className = "notice subtle";
    refs.writeBlocked.classList.remove("hidden");
    refs.writeBlocked.textContent = "게시판을 먼저 선택해 주세요.";
    return;
  }

  if (canCurrentUserWritePost()) {
    refs.writeForm.classList.remove("hidden");
    refs.writeBlocked.classList.add("hidden");
    return;
  }

  refs.writeForm.classList.add("hidden");
  refs.writeBlocked.className = "notice subtle";
  refs.writeBlocked.classList.remove("hidden");

  if (!state.user) {
    refs.writeBlocked.textContent = "";
    refs.writeBlocked.classList.add("hidden");
  } else if (state.needsNickname) {
    refs.writeBlocked.textContent = "닉네임 설정 후 글을 작성할 수 있습니다. 설정 페이지에서 닉네임을 등록해 주세요.";
  } else {
    refs.writeBlocked.className = "notice warn";
    refs.writeBlocked.textContent = "이 게시판은 어드민만 글을 작성할 수 있습니다.";
  }
}

function selectedBoard() {
  return state.boards.find((board) => board.id === state.selectedBoardId) || null;
}

function sortBoards(boards) {
  const allHaveSortOrder = boards.every((board) => Number.isFinite(Number(board?.sortOrder)));

  return [...boards].sort((a, b) => {
    if (allHaveSortOrder) {
      const orderDiff = Number(a.sortOrder) - Number(b.sortOrder);
      if (orderDiff !== 0) return orderDiff;
    }

    return toMillis(a.createdAt) - toMillis(b.createdAt);
  });
}

function canCurrentUserWritePost() {
  const board = selectedBoard();
  if (!state.user || !board || state.needsNickname) return false;
  return state.isAdmin || Boolean(board.allowUserPosts);
}

function setNotice(message, tone = "info") {
  refs.globalNotice.textContent = message;
  refs.globalNotice.className = `notice ${tone}`;
}

function toMillis(timestamp) {
  return timestamp?.toMillis ? timestamp.toMillis() : 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function currentUserName() {
  return (
    String(state.userProfile?.nickname || "").trim() ||
    state.user?.displayName ||
    state.user?.email ||
    "사용자"
  );
}

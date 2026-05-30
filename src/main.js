import "./style.css";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { auth, db, firebaseReady, signInWithGoogle, waitForRedirectResult } from "./firebase";
import {
  getTopbarRefs,
  initTopbarTheme,
  renderTopbar,
  renderTopbarAuth,
  wireTopbarEvents,
} from "./shared/topbar";

const params = new URLSearchParams(window.location.search);
const initialBoardId = params.get("boardId");

const state = {
  user: null,
  isAdmin: false,
  userProfile: null,
  needsNickname: false,
  boards: [],
  posts: [],
  selectedBoardId: initialBoardId,
  postSort: "latest",
  commentCounts: {},
  replyCounts: {},
};

let unsubscribeBoards = null;
let unsubscribePosts = null;
const commentCountUnsubscribers = new Map();
const replyCountUnsubscribersByPost = new Map();
const replyCountsByPostComment = new Map();

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="aurora one"></div>
  <div class="aurora two"></div>

  <div class="shell">
    ${renderTopbar("기록과 대화를 위한 작은 공간")}

    <section id="nicknameGate" class="panel gate hidden">
      <div class="panel-head">
        <h2><i class="fa-solid fa-user-pen h2-icon" aria-hidden="true"></i>닉네임 설정</h2>
        <span class="hint">최초 1회</span>
      </div>

      <p class="notice info">처음 로그인했어요. 게시글 작성을 위해 닉네임을 설정해 주세요.</p>

      <form id="nicknameForm" class="stack">
        <input id="nicknameInput" type="text" maxlength="20" placeholder="닉네임 (2~20자)" required />
        <button class="btn primary" type="submit">닉네임 저장</button>
      </form>
    </section>

    <p id="globalNotice" class="notice info">Firebase 연결을 준비 중입니다...</p>

    <main class="grid main-grid">
      <section class="panel col boards">
        <div class="panel-head">
          <h2><i class="fa-solid fa-table-columns h2-icon" aria-hidden="true"></i>게시판</h2>
        </div>

        <ul id="boardList" class="board-list"></ul>
      </section>

      <section class="panel col posts">
        <div class="panel-head">
          <h2><i class="fa-solid fa-newspaper h2-icon" aria-hidden="true"></i>게시글</h2>
          <label class="sort-control" for="postSortSelect">
            정렬
            <select id="postSortSelect" class="sort-select" aria-label="게시글 정렬">
              <option value="latest">최신순</option>
              <option value="oldest">오래된순</option>
            </select>
          </label>
        </div>

        <p id="postWriteHint" class="notice subtle hidden"></p>
        <ul id="postList" class="post-list"></ul>
        <a id="writePostBtn" class="btn primary write-post-btn hidden" href="/write.html">새로운 글 작성</a>
      </section>
    </main>
  </div>
`;

const refs = {
  ...getTopbarRefs(),
  nicknameGate: document.querySelector("#nicknameGate"),
  nicknameForm: document.querySelector("#nicknameForm"),
  nicknameInput: document.querySelector("#nicknameInput"),
  globalNotice: document.querySelector("#globalNotice"),
  boardList: document.querySelector("#boardList"),
  postSortSelect: document.querySelector("#postSortSelect"),
  postWriteHint: document.querySelector("#postWriteHint"),
  postList: document.querySelector("#postList"),
  writePostBtn: document.querySelector("#writePostBtn"),
};

initTopbarTheme(refs);
refs.postSortSelect.value = state.postSort;
wireUiEvents();
renderAll();

if (firebaseReady) {
  startAuthFlow();
  listenBoards();
  refs.globalNotice.classList.add("hidden");
} else {
  setNotice(".env 파일에 Firebase 정보를 채우면 로그인/작성 기능이 활성화됩니다.", "warn");
}

function wireUiEvents() {
  wireTopbarEvents({
    refs,
    onLoginRequested: async () => {
      if (!firebaseReady) return;
      try {
        await signInWithGoogle();
      } catch (error) {
        if (error?.code === "auth/configuration-not-found") {
          setNotice(
            "로그인 실패: Firebase Authentication이 아직 초기화되지 않았습니다. 콘솔에서 Authentication 시작 후 Google 제공자를 활성화해 주세요.",
            "error"
          );
        } else if (error?.code === "auth/unauthorized-domain") {
          setNotice(
            "로그인 실패: 현재 도메인이 인증 허용 도메인에 없습니다. Firebase Authentication 설정에서 localhost/127.0.0.1을 추가해 주세요.",
            "error"
          );
        } else {
          setNotice(`로그인 실패: ${error.message}`, "error");
        }
      }
    },
  });

  refs.boardList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-board-id]");
    if (!button) return;

    state.selectedBoardId = button.dataset.boardId;
    renderBoards();
    renderPosts();
    listenPosts(state.selectedBoardId);
  });

  refs.postSortSelect.addEventListener("change", () => {
    state.postSort = refs.postSortSelect.value === "oldest" ? "oldest" : "latest";
    renderPosts();
  });

  refs.nicknameForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!state.user) return;

    const nickname = refs.nicknameInput.value.trim();
    if (nickname.length < 2 || nickname.length > 20) {
      setNotice("닉네임은 2자 이상 20자 이하로 입력해 주세요.", "warn");
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
          createdAt: state.userProfile?.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
          lastLoginAt: serverTimestamp(),
        },
        { merge: true }
      );

      state.userProfile = {
        ...(state.userProfile || {}),
        uid: state.user.uid,
        email: state.user.email || "",
        photoURL: state.user.photoURL || "",
        nickname,
      };
      state.needsNickname = false;

      renderAuth();
      renderNicknameGate();
      renderPosts();

      setNotice("닉네임 설정이 완료되었습니다.", "success");
    } catch (error) {
      setNotice(`닉네임 저장 실패: ${error.message}`, "error");
    }
  });
}

async function startAuthFlow() {
  const redirectError = await waitForRedirectResult();
  if (redirectError) {
    setNotice(`리디렉트 로그인 실패: ${redirectError.message}`, "error");
  }

  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    state.isAdmin = false;
    state.userProfile = null;
    state.needsNickname = false;

    if (user) {
      state.isAdmin = await resolveAdminRole(user);
      await syncCurrentUserProfile(user);

      if (state.needsNickname) {
        setNotice("처음 로그인입니다. 닉네임을 먼저 설정해 주세요.", "info");
      } else {
        setNotice(`${currentUserName()} 님 환영합니다.`, "success");
      }
    }

    renderAuth();
    renderNicknameGate();
    renderBoards();
    renderPosts();
  });
}

async function syncCurrentUserProfile(user) {
  try {
    const profileRef = doc(db, "users", user.uid);
    const profileSnapshot = await getDoc(profileRef);

    if (!profileSnapshot.exists()) {
      state.userProfile = null;
      state.needsNickname = true;
      refs.nicknameInput.value = (user.displayName || "").trim().slice(0, 20);
      return;
    }

    state.userProfile = { id: profileSnapshot.id, ...profileSnapshot.data() };
    const nickname = String(state.userProfile.nickname || "").trim();
    state.needsNickname = nickname.length < 2;
    refs.nicknameInput.value = nickname || (user.displayName || "").trim().slice(0, 20);

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
  const email = user?.email?.toLowerCase() || "";
  let isAdmin = false;

  try {
    const roleSnapshot = await getDoc(doc(db, "settings", "roles"));
    if (roleSnapshot.exists()) {
      const admins = Array.isArray(roleSnapshot.data().admins)
        ? roleSnapshot
            .data()
            .admins.map((value) => String(value).trim().toLowerCase())
        : [];
      isAdmin = admins.includes(email);
    }
  } catch (error) {
    console.error("어드민 역할 확인 실패", error);
  }

  return isAdmin;
}

function listenBoards() {
  unsubscribeBoards?.();

  const boardQuery = collection(db, "boards");
  unsubscribeBoards = onSnapshot(
    boardQuery,
    (snapshot) => {
      state.boards = sortBoards(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));

      if (!state.selectedBoardId && state.boards.length) {
        state.selectedBoardId = state.boards[0].id;
      }

      if (state.selectedBoardId && !state.boards.some((board) => board.id === state.selectedBoardId)) {
        state.selectedBoardId = state.boards[0]?.id || null;
      }

      renderBoards();
      renderPosts();
      listenPosts(state.selectedBoardId);
    },
    (error) => setNotice(`게시판 조회 실패: ${error.message}`, "error")
  );
}

function listenPosts(boardId) {
  unsubscribePosts?.();

  state.posts = [];
  clearCommentCountListeners();
  state.commentCounts = {};
  state.replyCounts = {};

  if (!boardId) {
    renderPosts();
    return;
  }

  const postQuery = query(collection(db, "posts"), where("boardId", "==", boardId));

  unsubscribePosts = onSnapshot(
    postQuery,
    (snapshot) => {
      state.posts = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      syncCommentCountListeners();

      renderPosts();
    },
    (error) => setNotice(`게시글 조회 실패: ${error.message}`, "error")
  );
}

function syncCommentCountListeners() {
  const activePostIds = new Set(state.posts.map((post) => post.id));

  for (const [postId, unsubscribe] of commentCountUnsubscribers.entries()) {
    if (activePostIds.has(postId)) continue;
    unsubscribe();
    commentCountUnsubscribers.delete(postId);
    delete state.commentCounts[postId];
    clearReplyCountListenersForPost(postId);
  }

  for (const post of state.posts) {
    if (commentCountUnsubscribers.has(post.id)) continue;

    const unsubscribe = onSnapshot(
      collection(db, "posts", post.id, "comments"),
      (snapshot) => {
        state.commentCounts[post.id] = snapshot.size;
        syncReplyCountListeners(
          post.id,
          snapshot.docs.map((item) => item.id)
        );
        renderPosts();
      },
      () => {
        state.commentCounts[post.id] = 0;
        clearReplyCountListenersForPost(post.id);
        renderPosts();
      }
    );

    commentCountUnsubscribers.set(post.id, unsubscribe);
  }
}

function syncReplyCountListeners(postId, commentIds) {
  if (!replyCountUnsubscribersByPost.has(postId)) {
    replyCountUnsubscribersByPost.set(postId, new Map());
  }

  if (!replyCountsByPostComment.has(postId)) {
    replyCountsByPostComment.set(postId, new Map());
  }

  const postReplyUnsubscribers = replyCountUnsubscribersByPost.get(postId);
  const postReplyCounts = replyCountsByPostComment.get(postId);
  const activeCommentIds = new Set(commentIds);

  for (const [commentId, unsubscribe] of postReplyUnsubscribers.entries()) {
    if (activeCommentIds.has(commentId)) continue;
    unsubscribe();
    postReplyUnsubscribers.delete(commentId);
    postReplyCounts.delete(commentId);
  }

  for (const commentId of commentIds) {
    if (postReplyUnsubscribers.has(commentId)) continue;

    postReplyCounts.set(commentId, 0);

    const unsubscribe = onSnapshot(
      collection(db, "posts", postId, "comments", commentId, "replies"),
      (snapshot) => {
        postReplyCounts.set(commentId, snapshot.size);
        refreshReplyCountTotal(postId);
        renderPosts();
      },
      () => {
        postReplyCounts.set(commentId, 0);
        refreshReplyCountTotal(postId);
        renderPosts();
      }
    );

    postReplyUnsubscribers.set(commentId, unsubscribe);
  }

  refreshReplyCountTotal(postId);
}

function refreshReplyCountTotal(postId) {
  const postReplyCounts = replyCountsByPostComment.get(postId);
  if (!postReplyCounts) {
    state.replyCounts[postId] = 0;
    return;
  }

  let totalReplies = 0;
  for (const count of postReplyCounts.values()) {
    totalReplies += Number(count || 0);
  }

  state.replyCounts[postId] = totalReplies;
}

function clearReplyCountListenersForPost(postId) {
  const postReplyUnsubscribers = replyCountUnsubscribersByPost.get(postId);
  if (postReplyUnsubscribers) {
    for (const unsubscribe of postReplyUnsubscribers.values()) {
      unsubscribe();
    }
  }

  replyCountUnsubscribersByPost.delete(postId);
  replyCountsByPostComment.delete(postId);
  delete state.replyCounts[postId];
}

function clearCommentCountListeners() {
  for (const unsubscribe of commentCountUnsubscribers.values()) {
    unsubscribe();
  }
  commentCountUnsubscribers.clear();

  for (const postId of replyCountUnsubscribersByPost.keys()) {
    clearReplyCountListenersForPost(postId);
  }
}

function renderAll() {
  renderAuth();
  renderNicknameGate();
  renderBoards();
  renderPosts();
}

function renderAuth() {
  renderTopbarAuth({
    refs,
    user: state.user,
    isAdmin: state.isAdmin,
    userName: currentUserName(),
  });
}

function renderNicknameGate() {
  const visible = Boolean(state.user) && state.needsNickname;
  refs.nicknameGate.classList.toggle("hidden", !visible);
}

function renderBoards() {
  if (!state.boards.length) {
    refs.boardList.innerHTML = `<li class="empty-card">아직 게시판이 없습니다. 어드민이 첫 게시판을 생성해 주세요.</li>`;
    refs.writePostBtn.classList.add("hidden");
    refs.postWriteHint.classList.remove("hidden");
    refs.postWriteHint.textContent = "게시판이 준비되면 글을 작성할 수 있습니다.";
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

function renderPosts() {
  const board = selectedBoard();
  const sortedPosts = sortPostsBySelectedOrder(state.posts);

  if (!board) {
    refs.postList.innerHTML = `<li class="empty-card">게시판을 선택하면 게시글 목록이 보입니다.</li>`;
    refs.writePostBtn.classList.add("hidden");
    refs.postWriteHint.classList.add("hidden");
    refs.postWriteHint.textContent = "";
    return;
  }

  if (canCurrentUserWritePost()) {
    refs.writePostBtn.classList.remove("hidden");
    refs.postWriteHint.classList.add("hidden");
    refs.writePostBtn.href = buildWritePageUrl(board.id);
  } else {
    refs.writePostBtn.classList.add("hidden");
    refs.postWriteHint.className = "notice subtle";
    refs.postWriteHint.classList.remove("hidden");

    if (!state.user) {
      refs.postWriteHint.textContent = "";
      refs.postWriteHint.classList.add("hidden");
    } else if (state.needsNickname) {
      refs.postWriteHint.textContent = "닉네임 설정 후 글을 작성할 수 있습니다.";
    } else if (board.allowUserPosts) {
      refs.postWriteHint.textContent = "이 게시판에서는 로그인한 사용자 누구나 글을 작성할 수 있습니다.";
    } else {
      refs.postWriteHint.className = "notice warn";
      refs.postWriteHint.textContent = "이 게시판은 어드민만 글을 작성할 수 있습니다.";
    }
  }

  if (!sortedPosts.length) {
    refs.postList.innerHTML = `<li class="empty-card">아직 게시글이 없습니다. 첫 글을 남겨보세요.</li>`;
    return;
  }

  refs.postList.innerHTML = sortedPosts
    .map((post) => `
      <li>
        <a class="post-item" href="${buildPostPageUrl(board.id, post.id)}">
          <strong>${escapeHtml(post.title || "제목 없음")}</strong>
          <p>${escapeHtml(toPlainText(post.content || "").slice(0, 120))}</p>
          <span>${escapeHtml(post.authorName || "익명")} · ${formatDate(post.createdAt)}${renderEditedMeta(post)}${renderCommentCountMeta(post.id)}</span>
        </a>
      </li>
    `)
    .join("");
}

function sortPostsBySelectedOrder(posts) {
  const sorted = [...posts].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  if (state.postSort === "oldest") {
    sorted.reverse();
  }
  return sorted;
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

function formatDate(timestamp) {
  if (!timestamp?.toDate) return "방금 전";

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp.toDate());
}

function toMillis(timestamp) {
  return timestamp?.toMillis ? timestamp.toMillis() : 0;
}

function isEditedPost(post) {
  const createdMs = toMillis(post?.createdAt);
  const updatedMs = toMillis(post?.updatedAt);
  if (!createdMs || !updatedMs) return false;
  return updatedMs - createdMs > 1000;
}

function renderEditedMeta(post) {
  return isEditedPost(post) ? ` · <span class="edited-mark">수정됨</span>` : "";
}

function renderCommentCountMeta(postId) {
  const commentCount = Number(state.commentCounts[postId] || 0);
  const replyCount = Number(state.replyCounts[postId] || 0);
  return ` · 댓글 ${commentCount + replyCount}`;
}

function toPlainText(content) {
  const html = String(content || "");
  const temp = document.createElement("div");
  temp.innerHTML = html;
  return String(temp.textContent || "").trim();
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

function buildPostPageUrl(boardId, postId) {
  return `/post.html?boardId=${encodeURIComponent(boardId)}&postId=${encodeURIComponent(postId)}`;
}

function buildWritePageUrl(boardId) {
  return `/write.html?boardId=${encodeURIComponent(boardId)}`;
}


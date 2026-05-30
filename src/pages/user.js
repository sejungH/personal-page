import "../style.css";
import { onAuthStateChanged } from "firebase/auth";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { auth, db, firebaseReady, signInWithGoogle } from "../firebase";
import {
  getTopbarRefs,
  initTopbarTheme,
  renderTopbar,
  renderTopbarAuth,
  wireTopbarEvents,
} from "../shared/topbar";

const params = new URLSearchParams(window.location.search);
const targetUid = params.get("uid");

const state = {
  user: null,
  isAdmin: false,
  userProfile: null,
  targetUid,
  targetName: "",
  posts: [],
  comments: [],
  replies: [],
  activityPostTitles: {},
};

let unsubscribePosts = null;
let unsubscribeComments = null;
let unsubscribeReplies = null;
let postTitleSyncToken = 0;

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="aurora one"></div>
  <div class="aurora two"></div>

  <div class="shell">
    ${renderTopbar("유저 활동")}

    <p id="globalNotice" class="notice info hidden"></p>

    <section class="panel user-summary-panel">
      <div class="panel-head">
        <h2 id="userPageTitle"><i class="fa-solid fa-id-card h2-icon" aria-hidden="true"></i>유저 활동</h2>
      </div>
      <p id="userMeta" class="meta-text"></p>
    </section>

    <main class="grid user-main-grid">
      <section class="panel col">
        <div class="panel-head">
          <h2><i class="fa-solid fa-file-lines h2-icon" aria-hidden="true"></i>작성한 글</h2>
          <span class="hint" id="postCount">0건</span>
        </div>
        <ul id="userPostList" class="post-list"></ul>
      </section>

      <section class="panel col">
        <div class="panel-head">
          <h2><i class="fa-solid fa-comment-dots h2-icon" aria-hidden="true"></i>작성한 댓글</h2>
          <span class="hint" id="commentCount">0건</span>
        </div>
        <ul id="userCommentList" class="comment-list"></ul>
      </section>
    </main>
  </div>
`;

const refs = {
  ...getTopbarRefs(),
  globalNotice: document.querySelector("#globalNotice"),
  userPageTitle: document.querySelector("#userPageTitle"),
  userMeta: document.querySelector("#userMeta"),
  postCount: document.querySelector("#postCount"),
  commentCount: document.querySelector("#commentCount"),
  userPostList: document.querySelector("#userPostList"),
  userCommentList: document.querySelector("#userCommentList"),
};

initTopbarTheme(refs);
wireEvents();
renderAll();

if (!firebaseReady) {
  setNotice(".env 설정이 없어 유저 활동 조회가 제한됩니다.", "warn");
} else {
  startAuthFlow();

  if (!state.targetUid) {
    setNotice("조회할 유저가 지정되지 않았습니다.", "warn");
    renderAll();
  } else {
    listenPosts();
    listenComments();
    listenReplies();
    resolveTargetNameFromProfile();
  }
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
}

function startAuthFlow() {
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    state.isAdmin = false;
    state.userProfile = null;

    if (user) {
      state.isAdmin = await resolveAdminRole(user);
      await syncCurrentUserProfile(user);
    }

    renderAuth();
  });
}

async function resolveTargetNameFromProfile() {
  if (!state.targetUid) return;

  try {
    const profileSnapshot = await getDoc(doc(db, "users", state.targetUid));
    if (!profileSnapshot.exists()) return;

    const nickname = String(profileSnapshot.data().nickname || "").trim();
    if (!nickname) return;

    state.targetName = nickname;
    renderSummary();
  } catch {
    // Ignore permission errors for other users; fallback name is inferred from posts/comments.
  }
}

function listenPosts() {
  unsubscribePosts?.();

  const postQuery = query(collection(db, "posts"), where("authorUid", "==", state.targetUid));
  unsubscribePosts = onSnapshot(
    postQuery,
    (snapshot) => {
      state.posts = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

      inferTargetName();
      renderSummary();
      renderPosts();
    },
    (error) => setNotice(`유저 게시글 조회 실패: ${error.message}`, "error")
  );
}

function listenComments() {
  unsubscribeComments?.();

  const commentQuery = query(collectionGroup(db, "comments"), where("authorUid", "==", state.targetUid));
  unsubscribeComments = onSnapshot(
    commentQuery,
    (snapshot) => {
      applyCommentsSnapshot(snapshot);
    },
    (error) => {
      if (error?.code === "failed-precondition") {
        listenCommentsFallback();
        return;
      }

      setNotice(`유저 댓글 조회 실패: ${error.message}`, "error");
    }
  );
}

function listenCommentsFallback() {
  unsubscribeComments?.();

  unsubscribeComments = onSnapshot(
    collectionGroup(db, "comments"),
    (snapshot) => {
      applyCommentsSnapshot(snapshot, true);
    },
    (error) => setNotice(`유저 댓글 조회 실패: ${error.message}`, "error")
  );
}

function applyCommentsSnapshot(snapshot, filterByUid = false) {
  let items = snapshot.docs.map((item) => ({
    id: item.id,
    postId: item.ref.parent?.parent?.id || "",
    ...item.data(),
  }));

  if (filterByUid) {
    items = items.filter((item) => item.authorUid === state.targetUid);
  }

  state.comments = items.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  inferTargetName();
  renderSummary();
  renderComments();
  syncActivityPostTitles();
}

function listenReplies() {
  unsubscribeReplies?.();

  const replyQuery = query(collectionGroup(db, "replies"), where("authorUid", "==", state.targetUid));
  unsubscribeReplies = onSnapshot(
    replyQuery,
    (snapshot) => {
      applyRepliesSnapshot(snapshot);
    },
    (error) => {
      if (error?.code === "failed-precondition") {
        listenRepliesFallback();
        return;
      }

      setNotice(`유저 답글 조회 실패: ${error.message}`, "error");
    }
  );
}

function listenRepliesFallback() {
  unsubscribeReplies?.();

  unsubscribeReplies = onSnapshot(
    collectionGroup(db, "replies"),
    (snapshot) => {
      applyRepliesSnapshot(snapshot, true);
    },
    (error) => setNotice(`유저 답글 조회 실패: ${error.message}`, "error")
  );
}

function applyRepliesSnapshot(snapshot, filterByUid = false) {
  let items = snapshot.docs.map((item) => ({
    id: item.id,
    postId: item.ref.parent?.parent?.parent?.parent?.id || "",
    ...item.data(),
  }));

  if (filterByUid) {
    items = items.filter((item) => item.authorUid === state.targetUid);
  }

  state.replies = items.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  inferTargetName();
  renderSummary();
  renderComments();
  syncActivityPostTitles();
}

async function syncActivityPostTitles() {
  const comments = visibleComments();
  const postIds = [
    ...new Set(
      [...comments, ...state.replies]
        .map((item) => item.postId)
        .filter((postId) => Boolean(postId))
    ),
  ];

  const activeIdSet = new Set(postIds);
  Object.keys(state.activityPostTitles).forEach((postId) => {
    if (!activeIdSet.has(postId)) {
      delete state.activityPostTitles[postId];
    }
  });

  const missingPostIds = postIds.filter((postId) => !Object.hasOwn(state.activityPostTitles, postId));
  if (!missingPostIds.length) return;

  const token = ++postTitleSyncToken;
  const results = await Promise.all(
    missingPostIds.map(async (postId) => {
      try {
        const snapshot = await getDoc(doc(db, "posts", postId));
        if (!snapshot.exists()) {
          return [postId, "(삭제된 게시글)"];
        }

        const title = String(snapshot.data().title || "").trim();
        return [postId, title || "제목 없음"];
      } catch {
        return [postId, "(제목 조회 실패)"];
      }
    })
  );

  if (token !== postTitleSyncToken) return;

  results.forEach(([postId, title]) => {
    state.activityPostTitles[postId] = title;
  });

  renderComments();
}

function inferTargetName() {
  if (state.targetName) return;

  const candidate = [
    state.posts.find((item) => String(item.authorName || "").trim())?.authorName,
    state.comments.find((item) => String(item.authorName || "").trim())?.authorName,
    state.replies.find((item) => String(item.authorName || "").trim())?.authorName,
  ].find((name) => String(name || "").trim());

  if (!candidate) return;
  state.targetName = String(candidate).trim();
}

function renderAll() {
  renderAuth();
  renderSummary();
  renderPosts();
  renderComments();
}

function renderAuth() {
  renderTopbarAuth({
    refs,
    user: state.user,
    isAdmin: state.isAdmin,
    userName: currentUserName(),
  });
}

function renderSummary() {
  const displayName = state.targetName || "이름 미확인 사용자";
  const totalCommentCount = visibleComments().length + state.replies.length;

  refs.userPageTitle.innerHTML = `<i class="fa-solid fa-id-card h2-icon" aria-hidden="true"></i>${escapeHtml(
    displayName
  )}님의 활동`;
  refs.userMeta.textContent = `게시글 ${state.posts.length}개 · 댓글 ${totalCommentCount}개`;
  refs.postCount.textContent = `${state.posts.length}건`;
  refs.commentCount.textContent = `${totalCommentCount}건`;
}

function renderPosts() {
  if (!state.posts.length) {
    refs.userPostList.innerHTML = `<li class="empty-card">작성한 게시글이 없습니다.</li>`;
    return;
  }

  refs.userPostList.innerHTML = state.posts
    .map(
      (post) => `
      <li>
        <a class="post-item" href="${buildPostPageUrl(post.id, post.boardId)}">
          <strong>${escapeHtml(post.title || "제목 없음")}</strong>
          <p>${escapeHtml(toPlainText(post.content || "").slice(0, 140))}</p>
          <span>${formatDate(post.createdAt)}${renderEditedMeta(post)}</span>
        </a>
      </li>
    `
    )
    .join("");
}

function renderComments() {
  const comments = visibleComments();
  const activities = [
    ...comments.map((item) => ({ ...item, typeLabel: "댓글" })),
    ...state.replies.map((item) => ({ ...item, typeLabel: "답글" })),
  ].sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  if (!activities.length) {
    refs.userCommentList.innerHTML = `<li class="empty-card">작성한 댓글이 없습니다.</li>`;
    return;
  }

  refs.userCommentList.innerHTML = activities
    .map(
      (item) => {
        const href = item.postId ? buildPostPageUrl(item.postId) : "";

        return `
          <li>
            ${
              href
                ? `<a class="comment-item comment-item-link" href="${href}">`
                : `<div class="comment-item">`
            }
              <p>${escapeHtml(item.content || "")}</p>
              ${
                item.postId
                  ? `<p class="activity-post-title">게시글: ${escapeHtml(resolveActivityPostTitle(item.postId))}</p>`
                  : ""
              }
              <div class="comment-meta-row">
                <span>${item.typeLabel} · ${formatDate(item.createdAt)}</span>
              </div>
            ${href ? `</a>` : `</div>`}
          </li>
        `;
      }
    )
    .join("");
}

function resolveActivityPostTitle(postId) {
  if (!postId) return "-";

  if (Object.hasOwn(state.activityPostTitles, postId)) {
    return state.activityPostTitles[postId];
  }

  return "제목 불러오는 중...";
}

function setNotice(message, tone = "info") {
  refs.globalNotice.textContent = message;
  refs.globalNotice.className = `notice ${tone}`;
}

async function syncCurrentUserProfile(user) {
  try {
    const profileRef = doc(db, "users", user.uid);
    const profileSnapshot = await getDoc(profileRef);

    if (!profileSnapshot.exists()) {
      state.userProfile = null;
      return;
    }

    state.userProfile = { id: profileSnapshot.id, ...profileSnapshot.data() };

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
  } catch {
    state.userProfile = null;
  }
}

async function resolveAdminRole(user) {
  const email = user?.email?.toLowerCase() || "";

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

function currentUserName() {
  return (
    String(state.userProfile?.nickname || "").trim() ||
    state.user?.displayName ||
    state.user?.email ||
    "사용자"
  );
}

function buildPostPageUrl(postId, boardId) {
  if (boardId) {
    return `/post.html?boardId=${encodeURIComponent(boardId)}&postId=${encodeURIComponent(postId)}`;
  }

  return `/post.html?postId=${encodeURIComponent(postId)}`;
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

function visibleComments() {
  return state.comments.filter((item) => !item.deleted);
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

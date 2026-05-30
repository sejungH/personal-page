import "../style.css";
import "quill/dist/quill.snow.css";
import { onAuthStateChanged } from "firebase/auth";
import DOMPurify from "dompurify";
import Quill from "quill";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
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
const selectedPostId = params.get("postId");
const initialBoardId = params.get("boardId");

const state = {
  user: null,
  isAdmin: false,
  userProfile: null,
  needsNickname: false,
  boards: [],
  selectedBoardId: initialBoardId,
  post: null,
  comments: [],
  repliesByComment: {},
  replyOpenCommentId: null,
  isEditingPost: false,
  postEditEditor: null,
  postEditDraftTitle: "",
  postEditDraftContent: "",
  selectedPostId,
  postResolved: !selectedPostId,
};

let unsubscribeBoards = null;
let unsubscribePost = null;
let unsubscribeComments = null;
const replyUnsubscribers = new Map();

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="aurora one"></div>
  <div class="aurora two"></div>

  <div class="shell">
    ${renderTopbar("게시글 상세 보기")}

    <section id="nicknameGate" class="panel gate hidden">
      <div class="panel-head">
        <h2><i class="fa-solid fa-user-pen h2-icon" aria-hidden="true"></i>닉네임 설정 필요</h2>
        <span class="hint">댓글 작성 전</span>
      </div>
      <p class="notice info">닉네임 설정 후 댓글을 작성할 수 있습니다.</p>
      <div class="page-links">
        <a href="/settings.html" class="dropdown-item">설정으로 이동</a>
      </div>
    </section>

    <p id="globalNotice" class="notice info">게시글 정보를 불러오는 중입니다...</p>

    <main class="grid post-main-grid">
      <section id="postBoardCard" class="panel col boards post-board-card hidden">
        <div class="panel-head">
          <h2><i class="fa-solid fa-table-columns h2-icon" aria-hidden="true"></i>게시판</h2>
        </div>

        <ul id="boardList" class="board-list"></ul>
      </section>

      <p id="postNotFound" class="post-not-found hidden">게시글을 찾을 수 없습니다</p>

      <section id="postDetailColumn" class="post-detail-column hidden">
        <section id="postBodyCard" class="panel post-body-card empty">
          게시글을 불러오는 중입니다.
        </section>

        <section id="postCommentsCard" class="panel post-comments-card">
          <div class="panel-head">
            <h2><i class="fa-solid fa-comments h2-icon" aria-hidden="true"></i>댓글</h2>
          </div>

          <ul id="commentList" class="comment-list"></ul>

          <p id="commentBlocked" class="notice subtle hidden"></p>

          <form id="commentForm" class="stack hidden">
            <textarea id="commentBody" rows="3" maxlength="1000" placeholder="댓글을 입력하세요" required></textarea>
            <button class="btn" type="submit">댓글 등록</button>
          </form>
        </section>
      </section>
    </main>
  </div>
`;

const refs = {
  ...getTopbarRefs(),
  nicknameGate: document.querySelector("#nicknameGate"),
  globalNotice: document.querySelector("#globalNotice"),
  postBoardCard: document.querySelector("#postBoardCard"),
  boardList: document.querySelector("#boardList"),
  postNotFound: document.querySelector("#postNotFound"),
  postDetailColumn: document.querySelector("#postDetailColumn"),
  postBodyCard: document.querySelector("#postBodyCard"),
  postCommentsCard: document.querySelector("#postCommentsCard"),
  commentForm: document.querySelector("#commentForm"),
  commentBody: document.querySelector("#commentBody"),
  commentBlocked: document.querySelector("#commentBlocked"),
  commentList: document.querySelector("#commentList"),
};

initTopbarTheme(refs);
wireEvents();
renderAll();

if (firebaseReady) {
  startAuthFlow();
  listenBoards();

  if (state.selectedPostId) {
    listenPost(state.selectedPostId);
  } else {
    state.postResolved = true;
    setNotice("게시글이 선택되지 않았습니다. 홈에서 게시글을 선택해 주세요.", "warn");
    renderPostDetail();
  }
} else {
  state.postResolved = true;
  setNotice(".env 설정이 없어 Firebase 기능이 제한됩니다.", "warn");
  renderPostDetail();
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

  refs.postBodyCard.addEventListener("click", async (event) => {
    const editButton = event.target.closest("button[data-edit-post-id]");
    if (editButton) {
      const post = state.post;
      if (!post) return;

      if (!canCurrentUserEditPost(post)) {
        setNotice("게시글 수정 권한이 없습니다.", "warn");
        return;
      }

      state.isEditingPost = true;
      state.postEditDraftTitle = String(post.title || "");
      state.postEditDraftContent = toEditorHtml(post.content || "");
      renderPostDetail();
      return;
    }

    const cancelEditButton = event.target.closest("button[data-cancel-edit-post-id]");
    if (cancelEditButton) {
      state.isEditingPost = false;
      state.postEditEditor = null;
      state.postEditDraftTitle = "";
      state.postEditDraftContent = "";
      renderPostDetail();
      return;
    }

    const button = event.target.closest("button[data-delete-post-id]");
    if (!button) return;

    const post = state.post;
    if (!post) return;

    if (!canCurrentUserDeletePost(post)) {
      setNotice("게시글 삭제 권한이 없습니다.", "warn");
      return;
    }

    const confirmed = window.confirm("이 게시글과 댓글을 모두 삭제할까요?");
    if (!confirmed) return;

    try {
      await deletePostWithComments(post.id);
      setNotice("게시글을 삭제했습니다. 홈으로 이동합니다.", "success");
      window.location.href = "/";
    } catch (error) {
      setNotice(`게시글 삭제 실패: ${error.message}`, "error");
    }
  });

  refs.postBodyCard.addEventListener("submit", async (event) => {
    const editForm = event.target.closest("form[data-edit-post-id]");
    if (!editForm) return;

    event.preventDefault();

    const post = state.post;
    if (!post) {
      setNotice("게시글을 찾을 수 없습니다.", "warn");
      return;
    }

    if (!canCurrentUserEditPost(post)) {
      setNotice("게시글 수정 권한이 없습니다.", "warn");
      return;
    }

    const title = String(state.postEditDraftTitle || "").trim();
    const editor = state.postEditEditor;
    const content = editor?.root?.innerHTML || "";
    const plainText = editor?.getText().trim() || "";

    if (!title) {
      setNotice("제목을 입력해 주세요.", "warn");
      return;
    }

    if (!plainText) {
      setNotice("내용을 입력해 주세요.", "warn");
      return;
    }

    try {
      await updateDoc(doc(db, "posts", post.id), {
        title,
        content,
        updatedAt: serverTimestamp(),
      });

      state.isEditingPost = false;
      state.postEditEditor = null;
      state.postEditDraftTitle = "";
      state.postEditDraftContent = "";
      setNotice("게시글이 수정되었습니다.", "success");
    } catch (error) {
      setNotice(`게시글 수정 실패: ${error.message}`, "error");
    }
  });

  refs.postBodyCard.addEventListener("input", (event) => {
    const titleInput = event.target.closest("input[data-edit-post-title]");
    if (!titleInput) return;
    state.postEditDraftTitle = titleInput.value;
  });

  refs.commentList.addEventListener("click", async (event) => {
    const toggleReplyButton = event.target.closest("button[data-toggle-reply-id]");
    if (toggleReplyButton) {
      const commentId = toggleReplyButton.dataset.toggleReplyId;
      const targetComment = state.comments.find((item) => item.id === commentId);
      if (!targetComment) return;

      if (targetComment.deleted) {
        setNotice("삭제된 댓글에는 답글을 작성할 수 없습니다.", "warn");
        return;
      }

      if (!state.user) {
        return;
      }

      if (state.needsNickname) {
        setNotice("닉네임 설정 후 답글을 작성할 수 있습니다.", "warn");
        return;
      }

      state.replyOpenCommentId = state.replyOpenCommentId === commentId ? null : commentId;
      renderPostDetail();
      return;
    }

    const button = event.target.closest("button[data-delete-comment-id]");
    if (button) {
      const post = state.post;
      if (!post) return;

      const commentId = button.dataset.deleteCommentId;
      const comment = state.comments.find((item) => item.id === commentId);
      if (!comment) return;

      if (!canCurrentUserDeleteComment(comment)) {
        setNotice("댓글 삭제 권한이 없습니다.", "warn");
        return;
      }

      const confirmed = window.confirm("이 댓글을 삭제할까요?");
      if (!confirmed) return;

      try {
        const repliesSnapshot = await getDocs(
          collection(db, "posts", post.id, "comments", comment.id, "replies")
        );

        if (repliesSnapshot.size > 0) {
          await softDeleteComment(post.id, comment.id);
          setNotice("댓글을 삭제했습니다. 답글은 유지됩니다.", "success");
        } else {
          await deleteDoc(doc(db, "posts", post.id, "comments", comment.id));
          setNotice("댓글을 삭제했습니다.", "success");
        }
      } catch (error) {
        setNotice(`댓글 삭제 실패: ${error.message}`, "error");
      }
      return;
    }

    const deleteReplyButton = event.target.closest("button[data-delete-reply-id]");
    if (!deleteReplyButton) return;

    const post = state.post;
    if (!post) return;

    const commentId = deleteReplyButton.dataset.deleteReplyCommentId;
    const replyId = deleteReplyButton.dataset.deleteReplyId;
    const reply = state.repliesByComment[commentId]?.find((item) => item.id === replyId);
    if (!reply) return;

    if (!canCurrentUserDeleteReply(reply)) {
      setNotice("답글 삭제 권한이 없습니다.", "warn");
      return;
    }

    const confirmed = window.confirm("이 답글을 삭제할까요?");
    if (!confirmed) return;

    try {
      await deleteDoc(doc(db, "posts", post.id, "comments", commentId, "replies", replyId));
      setNotice("답글을 삭제했습니다.", "success");
    } catch (error) {
      setNotice(`답글 삭제 실패: ${error.message}`, "error");
    }
  });

  refs.commentList.addEventListener("submit", async (event) => {
    const replyForm = event.target.closest("form[data-reply-form-comment-id]");
    if (!replyForm) return;

    event.preventDefault();

    if (!state.user) {
      return;
    }

    if (state.needsNickname) {
      setNotice("닉네임 설정 후 답글을 작성할 수 있습니다.", "warn");
      return;
    }

    const post = state.post;
    if (!post) {
      setNotice("게시글을 찾을 수 없습니다.", "warn");
      return;
    }

    const commentId = replyForm.dataset.replyFormCommentId;
    const bodyInput = replyForm.querySelector("textarea[data-reply-body]");
    if (!commentId || !bodyInput) return;

    const content = bodyInput.value.trim();
    if (!content) return;

    try {
      await addDoc(collection(db, "posts", post.id, "comments", commentId, "replies"), {
        content,
        authorUid: state.user.uid,
        authorName: currentUserName(),
        authorPhotoURL: state.user.photoURL || "",
        createdAt: serverTimestamp(),
      });

      replyForm.reset();
      state.replyOpenCommentId = null;
      setNotice("답글이 등록되었습니다.", "success");
      renderPostDetail();
    } catch (error) {
      setNotice(`답글 등록 실패: ${error.message}`, "error");
    }
  });

  refs.commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!state.user) {
      return;
    }

    if (state.needsNickname) {
      setNotice("닉네임 설정 후 댓글을 작성할 수 있습니다.", "warn");
      return;
    }

    const post = state.post;
    if (!post) {
      setNotice("게시글을 찾을 수 없습니다.", "warn");
      return;
    }

    const content = refs.commentBody.value.trim();
    if (!content) return;

    try {
      await addDoc(collection(db, "posts", post.id, "comments"), {
        content,
        authorUid: state.user.uid,
        authorName: currentUserName(),
        authorPhotoURL: state.user.photoURL || "",
        createdAt: serverTimestamp(),
      });

      refs.commentForm.reset();
    } catch (error) {
      setNotice(`댓글 등록 실패: ${error.message}`, "error");
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

      if (state.needsNickname) {
        setNotice("닉네임 설정 후 댓글을 작성할 수 있습니다.", "info");
      }
    }

    renderAuth();
    renderNicknameGate();
    renderPostDetail();
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
  const email = user?.email?.toLowerCase() || "";

  try {
    const roleSnapshot = await getDoc(doc(db, "settings", "roles"));
    if (!roleSnapshot.exists()) return false;

    const admins = Array.isArray(roleSnapshot.data().admins)
      ? roleSnapshot.data().admins.map((value) => String(value).trim().toLowerCase())
      : [];

    return admins.includes(email);
  } catch (error) {
    console.error("어드민 역할 확인 실패", error);
    return false;
  }
}

function listenPost(postId) {
  unsubscribePost?.();

  state.post = null;
  state.postResolved = false;

  const postRef = doc(db, "posts", postId);
  unsubscribePost = onSnapshot(
    postRef,
    (snapshot) => {
      state.postResolved = true;

      if (!snapshot.exists()) {
        state.post = null;
        state.comments = [];
        state.repliesByComment = {};
        state.replyOpenCommentId = null;
        state.isEditingPost = false;
        unsubscribeComments?.();
        clearReplyListeners();
        setNotice("삭제되었거나 존재하지 않는 게시글입니다.", "warn");
        renderPostDetail();
        return;
      }

      state.post = { id: snapshot.id, ...snapshot.data() };
      if (state.isEditingPost && !canCurrentUserEditPost(state.post)) {
        state.isEditingPost = false;
        state.postEditEditor = null;
        state.postEditDraftTitle = "";
        state.postEditDraftContent = "";
      }
      state.selectedBoardId = state.post.boardId || state.selectedBoardId;
      setNotice("게시글 상세를 불러왔습니다.", "success");
      renderBoards();
      renderPostDetail();
      listenComments(state.post.id);
    },
    (error) => {
      state.postResolved = true;
      setNotice(`게시글 조회 실패: ${error.message}`, "error");
      renderPostDetail();
    }
  );
}

function listenBoards() {
  unsubscribeBoards?.();

  const boardQuery = collection(db, "boards");
  unsubscribeBoards = onSnapshot(
    boardQuery,
    (snapshot) => {
      state.boards = sortBoards(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      renderBoards();
    },
    (error) => setNotice(`게시판 조회 실패: ${error.message}`, "error")
  );
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

function listenComments(postId) {
  unsubscribeComments?.();
  clearReplyListeners();

  state.comments = [];
  state.repliesByComment = {};
  state.replyOpenCommentId = null;

  const commentQuery = query(collection(db, "posts", postId, "comments"), orderBy("createdAt", "asc"));

  unsubscribeComments = onSnapshot(
    commentQuery,
    (snapshot) => {
      state.comments = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));

      if (state.replyOpenCommentId && !state.comments.some((item) => item.id === state.replyOpenCommentId)) {
        state.replyOpenCommentId = null;
      }

      syncReplyListeners(postId);
      renderPostDetail();
    },
    (error) => setNotice(`댓글 조회 실패: ${error.message}`, "error")
  );
}

function syncReplyListeners(postId) {
  const activeCommentIds = new Set(state.comments.map((item) => item.id));

  for (const [commentId, unsubscribe] of replyUnsubscribers.entries()) {
    if (activeCommentIds.has(commentId)) continue;
    unsubscribe();
    replyUnsubscribers.delete(commentId);
    delete state.repliesByComment[commentId];
  }

  for (const comment of state.comments) {
    if (replyUnsubscribers.has(comment.id)) continue;

    const replyQuery = query(
      collection(db, "posts", postId, "comments", comment.id, "replies"),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(
      replyQuery,
      (snapshot) => {
        state.repliesByComment[comment.id] = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderPostDetail();
      },
      () => {
        state.repliesByComment[comment.id] = [];
        renderPostDetail();
      }
    );

    replyUnsubscribers.set(comment.id, unsubscribe);
  }
}

function clearReplyListeners() {
  for (const unsubscribe of replyUnsubscribers.values()) {
    unsubscribe();
  }
  replyUnsubscribers.clear();
}

function renderAll() {
  renderAuth();
  renderNicknameGate();
  renderBoards();
  renderPostDetail();
}

function renderBoards() {
  if (!state.boards.length) {
    refs.boardList.innerHTML = `<li class="empty-card">등록된 게시판이 없습니다.</li>`;
    return;
  }

  refs.boardList.innerHTML = state.boards
    .map((board) => {
      const selected = board.id === state.selectedBoardId;
      const targetUrl = `/?boardId=${encodeURIComponent(board.id)}`;

      return `
        <li>
          <a class="board-item ${selected ? "active" : ""}" href="${targetUrl}">
            <div>
              <strong>${escapeHtml(board.name || "이름 없는 게시판")}</strong>
              <p>${escapeHtml(board.description || "설명 없음")}</p>
            </div>
          </a>
        </li>
      `;
    })
    .join("");
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

function renderPostDetail() {
  const post = state.post;

  if (!post) {
    const showNotFound = state.postResolved;

    refs.postBoardCard.classList.add("hidden");
    refs.postDetailColumn.classList.add("hidden");
    refs.postNotFound.classList.toggle("hidden", !showNotFound);

    refs.postBodyCard.classList.add("empty");
    refs.postBodyCard.textContent = "게시글을 찾을 수 없습니다";
    refs.commentList.innerHTML = "";
    refs.commentForm.classList.add("hidden");
    refs.commentBlocked.classList.remove("hidden");
    refs.commentBlocked.textContent = "댓글을 작성하려면 먼저 게시글이 필요합니다.";
    return;
  }

  refs.postNotFound.classList.add("hidden");
  refs.postBoardCard.classList.remove("hidden");
  refs.postDetailColumn.classList.remove("hidden");

  refs.postBodyCard.classList.remove("empty");
  const canEdit = canCurrentUserEditPost(post);
  const canDelete = canCurrentUserDeletePost(post);

  refs.postBodyCard.innerHTML = `
    <div class="post-head-row">
      <div>
        <h3>${escapeHtml(post.title || "제목 없음")}</h3>
        <p>${renderAuthorLink(post.authorName || "익명", post.authorUid)} · ${formatDate(post.createdAt)}${renderEditedMeta(post)}</p>
      </div>
      <div class="post-head-actions">
        ${
          canEdit && !state.isEditingPost
            ? `<button class="btn" type="button" data-edit-post-id="${escapeHtml(post.id)}">수정</button>`
            : ""
        }
        ${
          canDelete && !state.isEditingPost
            ? `<button class="btn danger" type="button" data-delete-post-id="${escapeHtml(post.id)}">삭제</button>`
            : ""
        }
      </div>
    </div>
    <div class="section-divider" aria-hidden="true"></div>
    ${
      state.isEditingPost && canEdit
        ? `
          <form class="stack post-edit-form" data-edit-post-id="${escapeHtml(post.id)}">
            <input type="text" maxlength="80" data-edit-post-title value="${escapeHtml(state.postEditDraftTitle || "")}" required />
            <div class="rich-editor-shell post-edit-rich-editor-shell">
              <div class="rich-editor post-edit-rich-editor" data-edit-post-body></div>
            </div>
            <div class="post-edit-actions">
              <button class="btn primary" type="submit">수정 저장</button>
              <button class="btn" type="button" data-cancel-edit-post-id="${escapeHtml(post.id)}">취소</button>
            </div>
          </form>
        `
        : `<div class="post-body-content">${renderPostContent(post.content || "")}</div>`
    }
  `;

  if (state.isEditingPost && canEdit) {
    mountPostEditEditor();
  }

  if (state.user && !state.needsNickname) {
    refs.commentForm.classList.remove("hidden");
    refs.commentBlocked.classList.add("hidden");
  } else if (!state.user) {
    refs.commentForm.classList.add("hidden");
    refs.commentBlocked.classList.add("hidden");
    refs.commentBlocked.textContent = "";
  } else {
    refs.commentForm.classList.add("hidden");
    refs.commentBlocked.classList.remove("hidden");
    refs.commentBlocked.textContent = "닉네임 설정 후 댓글을 작성할 수 있습니다.";
  }

  const visibleComments = state.comments.filter((comment) => {
    const replies = state.repliesByComment[comment.id] || [];
    return !(comment.deleted && replies.length === 0);
  });

  if (!visibleComments.length) {
    refs.commentList.innerHTML = `<li class="empty-card">첫 댓글을 남겨보세요.</li>`;
    return;
  }

  refs.commentList.innerHTML = visibleComments
    .map((comment) => {
      const isDeleted = Boolean(comment.deleted);
      const canDelete = canCurrentUserDeleteComment(comment) && !isDeleted;
      const replies = state.repliesByComment[comment.id] || [];
      const isReplyFormOpen = state.replyOpenCommentId === comment.id;
      const canOpenReplyForm = state.user && !state.needsNickname && !isDeleted;

      return `
      <li class="comment-item">
        <p class="${isDeleted ? "deleted-comment-text" : ""}">${
          isDeleted ? "삭제된 댓글입니다" : escapeHtml(comment.content || "")
        }</p>
        <div class="comment-meta-row">
          <span>${
            isDeleted
              ? formatDate(comment.createdAt)
              : `${renderAuthorLink(comment.authorName || "익명", comment.authorUid)} · ${formatDate(comment.createdAt)}`
          }</span>
          <div class="comment-actions">
            ${
              !isDeleted
                ? `<button class="btn mini" type="button" data-toggle-reply-id="${escapeHtml(comment.id)}" ${
                    canOpenReplyForm ? "" : "disabled"
                  }>답글</button>`
                : ""
            }
            ${
              canDelete
                ? `<button class="btn danger mini" type="button" data-delete-comment-id="${escapeHtml(comment.id)}">삭제</button>`
                : ""
            }
          </div>
        </div>

        ${
          replies.length
            ? `<ul class="reply-list">${replies
                .map((reply) => {
                  const canDeleteReply = canCurrentUserDeleteReply(reply);
                  return `
                    <li class="reply-item">
                      <p>${escapeHtml(reply.content || "")}</p>
                      <div class="comment-meta-row reply-meta-row">
                        <span>${renderAuthorLink(reply.authorName || "익명", reply.authorUid)} · ${formatDate(reply.createdAt)}</span>
                        ${
                          canDeleteReply
                            ? `<button class="btn danger mini" type="button" data-delete-reply-comment-id="${escapeHtml(comment.id)}" data-delete-reply-id="${escapeHtml(reply.id)}">삭제</button>`
                            : ""
                        }
                      </div>
                    </li>
                  `;
                })
                .join("")}</ul>`
            : ""
        }

        ${
          !isDeleted
            ? `<form class="reply-form stack ${isReplyFormOpen ? "" : "hidden"}" data-reply-form-comment-id="${escapeHtml(
                comment.id
              )}">
                <textarea data-reply-body rows="2" maxlength="1000" placeholder="답글을 입력하세요" required></textarea>
                <button class="btn mini" type="submit">답글 등록</button>
              </form>`
            : ""
        }
      </li>
    `;
    })
    .join("");
}

function selectedBoard() {
  return state.boards.find((board) => board.id === state.selectedBoardId) || null;
}

function canCurrentUserDeletePost(post) {
  if (!state.user || !post) return false;
  return state.isAdmin || state.user.uid === post.authorUid;
}

function canCurrentUserEditPost(post) {
  if (!state.user || !post) return false;
  return state.isAdmin || state.user.uid === post.authorUid;
}

function canCurrentUserDeleteComment(comment) {
  if (!state.user || !comment) return false;
  return state.isAdmin || state.user.uid === comment.authorUid;
}

function canCurrentUserDeleteReply(reply) {
  if (!state.user || !reply) return false;
  return state.isAdmin || state.user.uid === reply.authorUid;
}

async function deletePostWithComments(postId) {
  const commentsSnapshot = await getDocs(collection(db, "posts", postId, "comments"));

  await Promise.all(
    commentsSnapshot.docs.map((item) => deleteCommentWithReplies(postId, item.id))
  );

  await deleteDoc(doc(db, "posts", postId));
}

async function deleteCommentWithReplies(postId, commentId) {
  const repliesSnapshot = await getDocs(collection(db, "posts", postId, "comments", commentId, "replies"));

  await Promise.all(
    repliesSnapshot.docs.map((item) =>
      deleteDoc(doc(db, "posts", postId, "comments", commentId, "replies", item.id))
    )
  );

  await deleteDoc(doc(db, "posts", postId, "comments", commentId));
}

async function softDeleteComment(postId, commentId) {
  await updateDoc(doc(db, "posts", postId, "comments", commentId), {
    content: "",
    deleted: true,
    deletedAt: serverTimestamp(),
  });
}

function setNotice(message, tone = "info") {
  refs.globalNotice.textContent = message;
  refs.globalNotice.className = `notice ${tone}`;
}

function renderAuthorLink(name, uid) {
  const safeName = escapeHtml(name || "익명");
  if (!uid) return safeName;
  return `<a class="author-link" href="${buildUserPageUrl(uid)}">${safeName}</a>`;
}

function buildUserPageUrl(uid) {
  return `/user.html?uid=${encodeURIComponent(uid)}`;
}

function formatDate(timestamp) {
  if (!timestamp?.toDate) return "방금 전";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp.toDate());
}

function timestampToMillis(timestamp) {
  return timestamp?.toMillis ? timestamp.toMillis() : 0;
}

function isEditedPost(post) {
  const createdMs = timestampToMillis(post?.createdAt);
  const updatedMs = timestampToMillis(post?.updatedAt);
  if (!createdMs || !updatedMs) return false;
  return updatedMs - createdMs > 1000;
}

function renderEditedMeta(post) {
  if (!isEditedPost(post)) return "";
  return ` · <span class="edited-mark">수정됨</span> (${formatDate(post.updatedAt)})`;
}

function renderPostContent(content) {
  const raw = String(content || "");
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);

  if (!looksLikeHtml) {
    return escapeHtml(raw).replace(/\n/g, "<br />");
  }

  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "u",
      "s",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "a",
      "img",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "src", "alt", "data-list"],
  });
}

function toEditorHtml(content) {
  const raw = String(content || "");
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
  if (looksLikeHtml) return raw;
  return `<p>${escapeHtml(raw).replace(/\n/g, "<br />")}</p>`;
}

function mountPostEditEditor() {
  const editorHost = refs.postBodyCard.querySelector("[data-edit-post-body]");
  if (!editorHost) return;

  const initialHtml = state.postEditDraftContent || toEditorHtml(state.post?.content || "");
  state.postEditEditor = new Quill(editorHost, {
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
          image: handlePostEditImageInsert,
        },
      },
    },
  });

  state.postEditEditor.root.innerHTML = initialHtml;
  state.postEditEditor.on("text-change", () => {
    state.postEditDraftContent = state.postEditEditor.root.innerHTML;
  });
}

function handlePostEditImageInsert() {
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

      const editor = state.postEditEditor;
      if (!editor) return;
      const range = editor.getSelection(true);
      editor.insertEmbed(range.index, "image", url, "user");
      editor.setSelection(range.index + 1, 0, "silent");

      setNotice("이미지 업로드가 완료되었습니다.", "success");
    } catch (error) {
      setNotice(`이미지 업로드 실패: ${error.message}`, "error");
    }
  });
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

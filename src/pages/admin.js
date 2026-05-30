import "../style.css";
import { onAuthStateChanged } from "firebase/auth";
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
  updateDoc,
  writeBatch,
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

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="aurora one"></div>
  <div class="aurora two"></div>

  <div class="page-shell">
    ${renderTopbar("어드민 페이지")}

    <section class="page-panel admin-page-panel">
      <p id="status" class="notice info">권한을 확인 중입니다...</p>

      <div class="admin-sections">
        <section class="admin-section-card">
          <div class="panel-head">
            <h2><i class="fa-solid fa-screwdriver-wrench h2-icon" aria-hidden="true"></i>게시판 관리</h2>
            <span class="hint">생성/수정/삭제</span>
          </div>

          <p id="boardStatus" class="notice info hidden">게시판 상태</p>

          <ul id="boardList" class="admin-board-list hidden"></ul>

          <div class="section-divider" aria-hidden="true"></div>

          <form id="boardForm" class="stack hidden">
            <input id="boardName" type="text" maxlength="40" placeholder="게시판 이름" required />
            <textarea id="boardDesc" rows="2" maxlength="120" placeholder="설명"></textarea>
            <label class="checkbox-row">
              <input id="boardAllowUserPosts" type="checkbox" />
              일반 유저도 이 게시판에 글 작성 허용
            </label>
            <button class="btn primary" type="submit">게시판 생성</button>
          </form>
        </section>

        <section class="admin-section-card">
          <div class="panel-head">
            <h2><i class="fa-solid fa-users h2-icon" aria-hidden="true"></i>사용자 목록</h2>
            <span class="hint">전체 사용자 조회</span>
          </div>

          <ul id="userList" class="admin-user-list hidden"></ul>
        </section>
      </div>
    </section>
  </div>
`;

const refs = {
  ...getTopbarRefs(),
  status: document.querySelector("#status"),
  boardStatus: document.querySelector("#boardStatus"),
  boardForm: document.querySelector("#boardForm"),
  boardName: document.querySelector("#boardName"),
  boardDesc: document.querySelector("#boardDesc"),
  boardAllowUserPosts: document.querySelector("#boardAllowUserPosts"),
  boardList: document.querySelector("#boardList"),
  userList: document.querySelector("#userList"),
};

let unsubscribeUsers = null;
let unsubscribeBoards = null;

const state = {
  user: null,
  isAdmin: false,
  boards: [],
  editingBoardId: null,
  draggingBoardId: null,
};

initTopbarTheme(refs);
wireEvents();
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
    unsubscribeUsers?.();
    unsubscribeBoards?.();

    state.user = user;
    state.isAdmin = false;
    state.boards = [];
    state.editingBoardId = null;

    renderTopbarAuth({ refs, user, isAdmin: false, userName: user?.displayName || user?.email || "" });

    refs.userList.classList.add("hidden");
    refs.userList.innerHTML = "";
    refs.boardList.classList.add("hidden");
    refs.boardList.innerHTML = "";
    refs.boardForm.classList.add("hidden");
    refs.boardStatus.classList.add("hidden");

    if (!user) {
      refs.status.textContent = "로그인이 필요합니다. 홈으로 돌아가 로그인해 주세요.";
      refs.status.className = "notice warn";
      return;
    }

    const headerUserName = await resolveHeaderUserName(user);
    state.isAdmin = await resolveAdminRole(user);
    renderTopbarAuth({ refs, user, isAdmin: state.isAdmin, userName: headerUserName });
    if (!state.isAdmin) {
      refs.status.textContent = "어드민만 접근할 수 있습니다.";
      refs.status.className = "notice error";
      return;
    }

    refs.status.textContent = "어드민 권한 확인 완료. 게시판/사용자 정보를 불러옵니다.";
    refs.status.className = "notice success";
    refs.boardForm.classList.remove("hidden");
    refs.boardList.classList.remove("hidden");
    refs.userList.classList.remove("hidden");

    listenBoards();
    listenUsers();
  });
}

function wireEvents() {
  refs.boardForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!state.user || !state.isAdmin) {
      setBoardStatus("게시판 생성 권한이 없습니다.", "warn");
      return;
    }

    const name = refs.boardName.value.trim();
    const description = refs.boardDesc.value.trim();
    const allowUserPosts = refs.boardAllowUserPosts.checked;

    if (!name) return;

    try {
      const finiteOrders = state.boards
        .map((board) => Number(board?.sortOrder))
        .filter((value) => Number.isFinite(value));
      const nextSortOrder = finiteOrders.length
        ? Math.max(...finiteOrders) + 1
        : state.boards.length;

      await addDoc(collection(db, "boards"), {
        name,
        description,
        allowUserPosts,
        sortOrder: nextSortOrder,
        createdAt: serverTimestamp(),
        createdByUid: state.user.uid,
      });

      refs.boardForm.reset();
      setBoardStatus("게시판이 생성되었습니다.", "success");
    } catch (error) {
      setBoardStatus(`게시판 생성 실패: ${error.message}`, "error");
    }
  });

  refs.boardList.addEventListener("click", async (event) => {
    const editButton = event.target.closest("button[data-edit-board-id]");
    if (editButton) {
      const boardId = editButton.dataset.editBoardId;
      if (!state.boards.some((item) => item.id === boardId)) return;
      state.editingBoardId = boardId;
      renderBoards();
      return;
    }

    const cancelButton = event.target.closest("button[data-cancel-edit-board-id]");
    if (cancelButton) {
      state.editingBoardId = null;
      renderBoards();
      return;
    }

    const button = event.target.closest("button[data-delete-board-id]");
    if (!button) return;

    const boardId = button.dataset.deleteBoardId;
    const board = state.boards.find((item) => item.id === boardId);
    if (!board) return;

    const confirmed = window.confirm(`게시판 '${board.name || "이름 없음"}'과 관련 게시글/댓글을 모두 삭제할까요?`);
    if (!confirmed) return;

    try {
      await deleteBoardWithPosts(boardId);
      setBoardStatus("게시판과 연관 글/댓글을 삭제했습니다.", "success");
    } catch (error) {
      setBoardStatus(`게시판 삭제 실패: ${error.message}`, "error");
    }
  });

  refs.boardList.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-edit-form-board-id]");
    if (!form) return;

    event.preventDefault();

    if (!state.user || !state.isAdmin) {
      setBoardStatus("게시판 수정 권한이 없습니다.", "warn");
      return;
    }

    const boardId = form.dataset.editFormBoardId;
    const nameInput = form.querySelector("[data-edit-name]");
    const descInput = form.querySelector("[data-edit-description]");
    const allowInput = form.querySelector("[data-edit-allow]");

    if (!nameInput || !descInput || !allowInput) return;

    const name = nameInput.value.trim();
    const description = descInput.value.trim();
    const allowUserPosts = allowInput.checked;

    if (!name) {
      setBoardStatus("게시판 이름을 입력해 주세요.", "warn");
      return;
    }

    try {
      await updateDoc(doc(db, "boards", boardId), {
        name,
        description,
        allowUserPosts,
        updatedAt: serverTimestamp(),
        updatedByUid: state.user.uid,
      });

      state.editingBoardId = null;
      setBoardStatus("게시판 정보가 수정되었습니다.", "success");
    } catch (error) {
      setBoardStatus(`게시판 수정 실패: ${error.message}`, "error");
    }
  });

  refs.boardList.addEventListener("dragstart", (event) => {
    const item = event.target.closest("li[data-board-id]");
    if (!item) return;

    const boardId = item.dataset.boardId;
    if (!boardId || state.editingBoardId === boardId) {
      event.preventDefault();
      return;
    }

    state.draggingBoardId = boardId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", boardId);

    item.classList.add("dragging");
  });

  refs.boardList.addEventListener("dragover", (event) => {
    if (!state.draggingBoardId) return;

    const item = event.target.closest("li[data-board-id]");
    if (!item) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    clearDragOverStyles();
    if (item.dataset.boardId !== state.draggingBoardId) {
      item.classList.add("drag-over");
    }
  });

  refs.boardList.addEventListener("drop", async (event) => {
    event.preventDefault();

    const targetItem = event.target.closest("li[data-board-id]");
    const draggingBoardId = state.draggingBoardId;

    clearDragStyles();

    if (!draggingBoardId || !targetItem) return;

    const targetBoardId = targetItem.dataset.boardId;
    if (!targetBoardId || targetBoardId === draggingBoardId) return;

    try {
      await reorderBoards(draggingBoardId, targetBoardId);
      setBoardStatus("게시판 순서를 저장했습니다.", "success");
    } catch (error) {
      setBoardStatus(`게시판 순서 저장 실패: ${error.message}`, "error");
    }
  });

  refs.boardList.addEventListener("dragend", () => {
    clearDragStyles();
  });
}

function listenBoards() {
  const boardsQuery = collection(db, "boards");
  unsubscribeBoards = onSnapshot(
    boardsQuery,
    (snapshot) => {
      state.boards = sortBoards(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));

      if (state.editingBoardId && !state.boards.some((item) => item.id === state.editingBoardId)) {
        state.editingBoardId = null;
      }

      renderBoards();
    },
    (error) => setBoardStatus(`게시판 목록 조회 실패: ${error.message}`, "error")
  );
}

function listenUsers() {
  const usersQuery = query(collection(db, "users"), orderBy("createdAt", "desc"));
  unsubscribeUsers = onSnapshot(
    usersQuery,
    (snapshot) => {
      const users = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      renderUsers(users);
    },
    (error) => {
      refs.status.textContent = `유저 목록 조회 실패: ${error.message}`;
      refs.status.className = "notice error";
    }
  );
}

function renderBoards() {
  if (!state.boards.length) {
    refs.boardList.innerHTML = `<li class="empty-card">등록된 게시판이 없습니다.</li>`;
    return;
  }

  refs.boardList.innerHTML = state.boards
    .map((board) => {
      const isEditing = state.editingBoardId === board.id;
      const escapedBoardId = escapeHtml(board.id);

      return `
        <li class="admin-board-item" data-board-id="${escapedBoardId}" draggable="${isEditing ? "false" : "true"}">
          <div class="admin-board-row ${isEditing ? "hidden" : ""}">
            <div>
              <strong>${escapeHtml(board.name || "이름 없는 게시판")}</strong>
              <p>${escapeHtml(board.description || "설명 없음")}</p>
              <span>드래그해서 순서를 변경할 수 있습니다.</span>
            </div>

            <div class="admin-board-actions">
              <button class="btn mini" type="button" data-edit-board-id="${escapedBoardId}">수정</button>
              <button class="btn danger mini" type="button" data-delete-board-id="${escapedBoardId}">삭제</button>
            </div>
          </div>

          <form class="admin-board-edit stack ${isEditing ? "" : "hidden"}" data-edit-form-board-id="${escapedBoardId}">
            <input data-edit-name type="text" maxlength="40" value="${escapeHtml(board.name || "")}" required />
            <textarea data-edit-description rows="2" maxlength="120" placeholder="설명">${escapeHtml(board.description || "")}</textarea>
            <label class="checkbox-row">
              <input data-edit-allow type="checkbox" ${board.allowUserPosts ? "checked" : ""} />
              일반 유저도 이 게시판에 글 작성 허용
            </label>

            <div class="admin-board-actions">
              <button class="btn primary mini" type="submit">저장</button>
              <button class="btn mini" type="button" data-cancel-edit-board-id="${escapedBoardId}">취소</button>
            </div>
          </form>
        </li>
      `;
    })
    .join("");
}

async function reorderBoards(draggingBoardId, targetBoardId) {
  if (!state.user || !state.isAdmin) {
    throw new Error("게시판 순서 변경 권한이 없습니다.");
  }

  const fromIndex = state.boards.findIndex((board) => board.id === draggingBoardId);
  const toIndex = state.boards.findIndex((board) => board.id === targetBoardId);

  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

  const nextBoards = [...state.boards];
  const [movedBoard] = nextBoards.splice(fromIndex, 1);
  nextBoards.splice(toIndex, 0, movedBoard);

  const batch = writeBatch(db);
  nextBoards.forEach((board, index) => {
    batch.update(doc(db, "boards", board.id), {
      sortOrder: index,
      updatedAt: serverTimestamp(),
      updatedByUid: state.user.uid,
    });
  });

  await batch.commit();
}

function clearDragOverStyles() {
  refs.boardList
    .querySelectorAll(".admin-board-item.drag-over")
    .forEach((item) => item.classList.remove("drag-over"));
}

function clearDragStyles() {
  state.draggingBoardId = null;
  refs.boardList
    .querySelectorAll(".admin-board-item.dragging")
    .forEach((item) => item.classList.remove("dragging"));
  clearDragOverStyles();
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

function renderUsers(users) {
  if (!users.length) {
    refs.userList.innerHTML = `<li class="empty-card">등록된 유저 문서가 없습니다.</li>`;
    return;
  }

  refs.userList.innerHTML = users
    .map((profile) => {
      const nickname = escapeHtml(profile.nickname || "(닉네임 미설정)");
      const email = escapeHtml(profile.email || "이메일 없음");
      const uid = escapeHtml(profile.uid || profile.id || "-");
      const userPageUrl = profile.uid || profile.id
        ? `/user.html?uid=${encodeURIComponent(profile.uid || profile.id)}`
        : "";

      return `
        <li class="admin-user-item">
          <strong>${userPageUrl ? `<a class="author-link" href="${userPageUrl}">${nickname}</a>` : nickname}</strong>
          <p>${email}</p>
          <span>UID: ${uid}</span>
          <span>마지막 로그인: ${formatDate(profile.lastLoginAt)}</span>
        </li>
      `;
    })
    .join("");
}

async function resolveHeaderUserName(user) {
  const fallbackName = user?.displayName || user?.email || "";

  try {
    const profileSnapshot = await getDoc(doc(db, "users", user.uid));
    if (!profileSnapshot.exists()) return fallbackName;

    const nickname = String(profileSnapshot.data().nickname || "").trim();
    return nickname.length >= 2 ? nickname : fallbackName;
  } catch {
    return fallbackName;
  }
}

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

async function deleteBoardWithPosts(boardId) {
  const postsSnapshot = await getDocs(query(collection(db, "posts"), where("boardId", "==", boardId)));

  for (const postDoc of postsSnapshot.docs) {
    const commentsSnapshot = await getDocs(collection(db, "posts", postDoc.id, "comments"));

    for (const commentDoc of commentsSnapshot.docs) {
      const repliesSnapshot = await getDocs(collection(db, "posts", postDoc.id, "comments", commentDoc.id, "replies"));

      await Promise.all(
        repliesSnapshot.docs.map((replyDoc) =>
          deleteDoc(doc(db, "posts", postDoc.id, "comments", commentDoc.id, "replies", replyDoc.id))
        )
      );

      await deleteDoc(doc(db, "posts", postDoc.id, "comments", commentDoc.id));
    }

    await deleteDoc(doc(db, "posts", postDoc.id));
  }

  await deleteDoc(doc(db, "boards", boardId));
}

function setBoardStatus(message, tone = "info") {
  refs.boardStatus.textContent = message;
  refs.boardStatus.className = `notice ${tone}`;
  refs.boardStatus.classList.remove("hidden");
}

function formatDate(timestamp) {
  if (!timestamp?.toDate) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp.toDate());
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

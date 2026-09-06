import Quill from "quill";
import {
  $,
  client,
  unwrap,
  cleanHTML,
  safeImage,
  element,
  date,
  message,
  bounded,
  busy,
  slugValid,
  coverPath,
  failure,
} from "./shared.js";
let db,
  editor,
  current = null,
  dirty = false,
  removeCover = false,
  saving = false,
  recovering = false;
let sessionCheckId = 0;
let editorLoadId = 0;
let postOffset = 0,
  pendingOffset = 0;
const SIZE = 20;
function setDirty() {
  dirty = true;
}
function confirmLeave() {
  return !dirty || window.confirm("Discard unsaved changes?");
}
function resetPost(post = null) {
  editorLoadId++;
  current = post;
  $("delete-post-action").hidden = !post;
  removeCover = false;
  $("post-form").reset();
  for (const field of ["title", "slug", "excerpt"])
    $(field).value = post?.[field] || "";
  $("tags").value = Array.isArray(post?.tags) ? post.tags.join(", ") : "";
  editor.clipboard.dangerouslyPasteHTML(cleanHTML(post?.content || ""));
  const url = safeImage(post?.cover_image_url);
  $("cover-preview").hidden = !url;
  $("cover-preview").src = url || "";
  $("remove-cover").hidden = !url;
  $("editor-heading").textContent = post ? "Edit post" : "New post";
  message("save-message", "");
  dirty = false;
}
async function loadPosts(reset = false) {
  if (reset) {
    postOffset = 0;
    $("post-list").replaceChildren();
  }
  const rows = unwrap(
    await db
      .from("posts")
      .select("id,title,status,updated_at")
      .order("updated_at", { ascending: false })
      .order("id")
      .range(postOffset, postOffset + SIZE - 1),
  );
  for (const p of rows) {
    const row = element("div", undefined, "admin-post");
    const button = element("button", "Edit");
    button.type = "button";
    button.onclick = () => {
      if (saving || !confirmLeave()) return;
      const loadId = ++editorLoadId;
      busy(button, async () => {
        try {
          const full = unwrap(
            await db.from("posts").select("*").eq("id", p.id).single(),
          );
          if (saving || loadId !== editorLoadId) return;
          resetPost(full);
          $("title").focus();
        } catch {
          message("message", "Could not open the post. Try again.");
        }
      });
    };
    row.append(element("span", `${p.title} · ${p.status}`), button);
    $("post-list").append(row);
  }
  postOffset += rows.length;
  $("more-posts").hidden = rows.length < SIZE;
  if (!postOffset) $("post-list").append(element("p", "No posts yet."));
}
async function loadPending(reset = false) {
  if (reset) {
    pendingOffset = 0;
    $("pending").replaceChildren();
  }
  const rows = unwrap(
    await db
      .from("comments")
      .select("id,post_id,name,content,created_at")
      .eq("approved", false)
      .order("created_at")
      .order("id")
      .range(pendingOffset, pendingOffset + SIZE - 1),
  );
  for (const c of rows) {
    const row = element("article", undefined, "comment");
    row.append(
      element("strong", c.name),
      element("p", c.content),
      element("p", `Post ${c.post_id} · ${date(c.created_at)}`, "hint"),
    );
    const actions = element("div", undefined, "actions");
    for (const action of ["Approve", "Delete"]) {
      const button = element("button", action);
      button.type = "button";
      button.onclick = async () => {
        if (
          action === "Delete" &&
          !window.confirm("Permanently delete this comment?")
        )
          return;
        for (const b of actions.children) b.disabled = true;
        try {
          const query =
            action === "Approve"
              ? db.from("comments").update({ approved: true })
              : db.from("comments").delete();
          const changed = unwrap(
            await query.eq("id", c.id).eq("approved", false).select("id"),
          );
          if (!changed.length) throw Error("No change");
          row.remove();
          pendingOffset = Math.max(0, pendingOffset - 1);
          message(
            "moderation-message",
            `Comment ${action === "Approve" ? "approved" : "deleted"}.`,
          );
        } catch {
          message(
            "moderation-message",
            "Could not moderate this comment. Refresh and try again.",
          );
          for (const b of actions.children) b.disabled = false;
        }
      };
      actions.append(button);
    }
    row.append(actions);
    $("pending").append(row);
  }
  pendingOffset += rows.length;
  $("more-pending").hidden = rows.length < SIZE;
  message("moderation-message", pendingOffset ? "" : "No pending comments.");
}
async function deleteManagedCover(url, id) {
  const path = coverPath(url);
  // Never delete a legacy or shared image whose ownership cannot be inferred.
  if (!path || !path.startsWith(id + "/")) return false;
  unwrap(await db.storage.from("blog-covers").remove([path]));
  return true;
}
async function deletePost() {
  if (!current || saving || recovering || $("desk").hidden) return;
  const post = current;
  const confirmation =
    `Permanently delete “${post.title}” and its comments and likes? This cannot be undone.` +
    (dirty ? " Your unsaved changes will also be lost." : "");
  if (!window.confirm(confirmation)) return;

  // Share the save lock so save/delete and repeat clicks cannot overlap.
  saving = true;
  const controls = [...$("desk").querySelectorAll("button,input,textarea")];
  const disabled = controls.map((control) => control.disabled);
  controls.forEach((control) => (control.disabled = true));
  editor.enable(false);
  message("save-message", "Deleting post…");
  let databaseDeleted = false;
  try {
    let query = db.from("posts").delete().eq("id", post.id);
    query = post.updated_at
      ? query.eq("updated_at", post.updated_at)
      : query.is("updated_at", null);
    const deleted = unwrap(
      await query.select("id,cover_image_url").maybeSingle(),
    );
    if (!deleted) {
      message(
        "save-message",
        "No post was deleted. It may have changed, already been deleted, or permission was denied. Reopen or refresh the post before deleting.",
      );
      return;
    }

    // The database is authoritative; comments and likes cascade there.
    databaseDeleted = true;
    resetPost();
    let status = "Post deleted permanently.";
    if (deleted.cover_image_url) {
      try {
        if (!(await deleteManagedCover(deleted.cover_image_url, deleted.id)))
          status +=
            " Its external or legacy cover was retained because it is not managed by this post.";
      } catch {
        status += " Its old cover image may need manual removal from Storage.";
      }
    }
    const refreshed = await Promise.allSettled([
      loadPosts(true),
      loadPending(true),
    ]);
    if (refreshed.some((result) => result.status === "rejected"))
      status +=
        " Some lists could not refresh. Reload to see the current posts and pending comments.";
    message("save-message", status);
  } catch {
    // A lost response can be ambiguous. Never remove the cover without a
    // confirmed deleted row, and never expose the backend's raw error.
    message(
      "save-message",
      databaseDeleted
        ? "Post deleted permanently. Reload the admin page; its lists or cover cleanup may need attention."
        : "Could not confirm post deletion. Check your connection and permissions, then reopen or refresh the post before trying again.",
    );
  } finally {
    controls.forEach((control, index) => (control.disabled = disabled[index]));
    editor.enable(true);
    saving = false;
  }
}
async function save(event) {
  event.preventDefault();
  if (saving) return;
  const status = event.submitter?.value;
  if (!["draft", "published"].includes(status)) return;
  let payload, file;
  try {
    const title = bounded($("title").value, 1, 160, "Title");
    const slug = $("slug").value.trim();
    if (!slugValid(slug))
      throw Error(
        "Use a valid lowercase slug with letters, numbers and hyphens.",
      );
    const excerpt = bounded($("excerpt").value, 1, 400, "Excerpt");
    const content = cleanHTML(editor.getSemanticHTML());
    bounded(editor.getText(), 1, 100000, "Content");
    if (content.length > 200000) throw Error("Formatted content is too long.");
    const tags = [
      ...new Set(
        $("tags")
          .value.split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
    if (tags.length > 10 || tags.some((t) => t.length > 30))
      throw Error("Use up to 10 tags, each at most 30 characters.");
    file = $("cover-file").files[0];
    if (
      file &&
      (!["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 5 * 1024 * 1024)
    )
      throw Error("Choose a JPEG, PNG or WebP image up to 5 MB.");
    payload = {
      title,
      slug,
      excerpt,
      content,
      tags,
      status,
      updated_at: new Date().toISOString(),
      published_at:
        status === "published"
          ? current?.published_at || new Date().toISOString()
          : null,
    };
  } catch (e) {
    message("save-message", e.message);
    return;
  }
  saving = true;
  const controls = [...$("desk").querySelectorAll("button,input,textarea")];
  const disabled = controls.map((c) => c.disabled);
  controls.forEach((c) => (c.disabled = true));
  editor.enable(false);
  const id = current?.id || crypto.randomUUID();
  let uploaded = null,
    saved = false;
  message("save-message", "Saving…");
  try {
    let url = removeCover ? null : current?.cover_image_url || null;
    if (file) {
      const extension = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      }[file.type];
      const path = `${id}/${crypto.randomUUID()}.${extension}`;
      unwrap(
        await db.storage.from("blog-covers").upload(path, file, {
          contentType: file.type,
          upsert: false,
          cacheControl: "31536000",
        }),
      );
      uploaded = db.storage.from("blog-covers").getPublicUrl(path)
        .data.publicUrl;
      url = uploaded;
    }
    payload.cover_image_url = url;
    let query;
    if (current) {
      query = db.from("posts").update(payload).eq("id", id);
      query = current.updated_at
        ? query.eq("updated_at", current.updated_at)
        : query.is("updated_at", null);
    } else query = db.from("posts").insert({ id, ...payload });
    const result = await query.select("*").maybeSingle();
    if (result.error) throw result.error;
    if (!result.data)
      throw Error(
        "This post changed in another session or permission was denied. Reopen it before saving.",
      );
    saved = true;
    const previous = current?.cover_image_url;
    resetPost(result.data);
    let warning = "";
    if (previous && previous !== url) {
      try {
        if (!(await deleteManagedCover(previous, id)))
          warning =
            " The previous external/legacy image was retained; remove it manually if unused.";
      } catch {
        warning =
          " Saved, but the old image could not be deleted. Remove it from Storage if unused.";
      }
    }
    message(
      "save-message",
      (status === "published" ? "Published." : "Draft saved; not public.") +
        warning,
    );
    try {
      await loadPosts(true);
    } catch {
      message(
        "message",
        "Post saved, but the list could not refresh. Reload when ready.",
      );
    }
  } catch (e) {
    // A network failure can be ambiguous: keep the upload instead of deleting a file
    // that a successfully committed post may now reference.
    message(
      "save-message",
      (e.code ? failure(e) : e.message) +
        (uploaded && !saved
          ? " An uploaded image may remain in Storage. Reopen the post before retrying."
          : ""),
    );
  } finally {
    controls.forEach((c, i) => (c.disabled = disabled[i]));
    editor.enable(true);
    saving = false;
  }
}
async function checkSession(successMessage = "") {
  if (recovering) return;
  const checkId = ++sessionCheckId;
  $("desk").hidden = true;
  $("login").hidden = true;
  const { data, error } = await db.auth.getUser();
  // Auth events can arrive while getUser is pending. Never restore stale UI.
  if (recovering || checkId !== sessionCheckId) return;
  if (error || !data.user) {
    $("login").hidden = false;
    message("message", "Sign in with the existing authorized account.");
    return;
  }
  if (data.user.id !== window.BLOG_CONFIG.admin) {
    await db.auth.signOut();
    $("login").hidden = false;
    message("message", "This account is not authorized to manage the blog.");
    return;
  }
  $("desk").hidden = false;
  message("message", successMessage);
  resetPost();
  const results = await Promise.allSettled([
    loadPosts(true),
    loadPending(true),
  ]);
  if (recovering || checkId !== sessionCheckId) return;
  if (results.some((r) => r.status === "rejected"))
    message(
      "message",
      "Some admin data could not load. Check your connection and Supabase policies, then reload.",
    );
}
try {
  db = client(true);
  editor = new Quill("#editor", {
    theme: "snow",
    formats: [
      "header",
      "bold",
      "italic",
      "underline",
      "strike",
      "blockquote",
      "code-block",
      "list",
      "link",
    ],
    modules: {
      toolbar: [
        [{ header: 2 }, { header: 3 }],
        ["bold", "italic", "underline"],
        ["blockquote", "code-block"],
        [{ list: "ordered" }, { list: "bullet" }],
        ["link", "clean"],
      ],
    },
  });
  editor.root.setAttribute("aria-labelledby", "content-label");
  editor.root.setAttribute("role", "textbox");
  editor.root.setAttribute("aria-multiline", "true");
  document.querySelectorAll(".ql-toolbar button").forEach((b) => {
    b.type = "button";
    b.setAttribute(
      "aria-label",
      (b.className.replace("ql-", "") + " " + (b.value || "")).trim(),
    );
  });
  editor.on("text-change", setDirty);
  $("post-form").oninput = setDirty;
  $("title").oninput = () => {
    if (!current && !$("slug").dataset.edited)
      $("slug").value = $("title")
        .value.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120);
  };
  $("slug").oninput = () => {
    $("slug").dataset.edited = "true";
  };
  $("new").onclick = () => {
    if (confirmLeave()) {
      delete $("slug").dataset.edited;
      resetPost();
      $("title").focus();
    }
  };
  $("remove-cover").onclick = () => {
    removeCover = true;
    $("cover-file").value = "";
    $("cover-preview").hidden = true;
    $("remove-cover").hidden = true;
    setDirty();
  };
  $("cover-file").onchange = () => {
    setDirty();
    message("save-message", "Selected image will be uploaded when you save.");
  };
  $("post-form").onsubmit = save;
  $("delete-post").onclick = deletePost;
  $("login").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      try {
        unwrap(
          await db.auth.signInWithPassword({
            email: $("login-email").value.trim(),
            password: $("password").value,
          }),
        );
        $("password").value = "";
        await checkSession();
      } catch {
        message(
          "message",
          "Sign-in failed. Check your credentials and connection.",
        );
      }
    });
  };
  $("recovery").onsubmit = (e) => {
    e.preventDefault();
    if (!recovering) return;
    const password = $("new-password").value;
    const confirmation = $("confirm-password").value;
    if (password.length < 8) {
      message(
        "recovery-message",
        "Use at least 8 characters for your password.",
      );
      return;
    }
    if (password !== confirmation) {
      message("recovery-message", "Passwords must match.");
      return;
    }
    busy(
      e.submitter || $("recovery").querySelector("button[type=submit]"),
      async () => {
        message("recovery-message", "Updating password…");
        try {
          unwrap(await db.auth.updateUser({ password }));
          // A concurrent sign-out must keep the signed-out UI in control.
          if (!recovering) return;
          $("recovery").reset();
          $("recovery").hidden = true;
          recovering = false;
          message("recovery-message", "");
          message("message", "Password updated.");
          await checkSession("Password updated.");
        } catch {
          if (recovering)
            message(
              "recovery-message",
              "Could not update the password. Request a new recovery link and try again.",
            );
        }
      },
    );
  };
  $("logout").onclick = () => {
    if (confirmLeave())
      busy($("logout"), async () => {
        try {
          unwrap(await db.auth.signOut());
          dirty = false;
          resetPost();
          $("desk").hidden = true;
          $("login").hidden = false;
          message("message", "Signed out.");
        } catch {
          message("message", "Could not sign out. Please try again.");
        }
      });
  };
  for (const [id, fn] of [
    ["more-posts", () => loadPosts()],
    ["more-pending", () => loadPending()],
    ["refresh-comments", () => loadPending(true)],
  ])
    $(id).onclick = () =>
      busy($(id), async () => {
        try {
          await fn();
        } catch {
          message("message", "Could not refresh data. Try again.");
        }
      });
  db.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
      recovering = true;
      sessionCheckId++;
      $("desk").hidden = true;
      $("login").hidden = true;
      $("recovery").reset();
      $("recovery").hidden = false;
      message("recovery-message", "");
      message("message", "Choose a new password.");
    } else if (event === "SIGNED_OUT") {
      recovering = false;
      sessionCheckId++;
      $("recovery").reset();
      $("recovery").hidden = true;
      message("recovery-message", "");
      dirty = false;
      $("desk").hidden = true;
      $("login").hidden = false;
      message("message", "Session ended. Sign in again.");
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty || saving) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  await checkSession();
} catch {
  message(
    "message",
    "Admin could not load. Check the blog configuration and reload.",
  );
}

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
} from "./shared.js";
let db;
const PAGE = 12;
async function listing() {
  let offset = 0;
  const load = async () => {
    const posts = unwrap(
      await db
        .from("posts")
        .select("id,title,slug,excerpt,published_at,tags")
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .order("id")
        .range(offset, offset + PAGE - 1),
    );
    for (const p of posts) {
      if (!slugValid(p.slug)) continue;
      const row = element("article", undefined, "post-entry");
      const heading = element("h2");
      const a = element("a", p.title);
      a.href = "/blog/" + encodeURIComponent(p.slug);
      heading.append(a);
      const time = element("time", date(p.published_at));
      if (p.published_at) time.dateTime = p.published_at;
      row.append(time, heading, element("p", p.excerpt));
      $("posts").append(row);
    }
    offset += posts.length;
    $("more").hidden = posts.length < PAGE;
    message(
      "message",
      offset ? "" : "No posts published yet. Check back soon.",
    );
  };
  $("more").onclick = () =>
    busy($("more"), async () => {
      try {
        await load();
      } catch {
        message("message", "Could not load posts. Please reload or try again.");
      }
    });
  await load();
}
function visitor() {
  let id = localStorage.getItem("blog-visitor");
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) {
    id = crypto.randomUUID();
    localStorage.setItem("blog-visitor", id);
  }
  return id;
}
async function postPage() {
  const slug = decodeURIComponent(
    location.pathname.replace(/\/$/, "").split("/").pop(),
  );
  if (!slugValid(slug)) {
    message("message", "Post not found.");
    return;
  }
  const p = unwrap(
    await db
      .from("posts")
      .select("id,title,slug,excerpt,content,cover_image_url,tags,published_at")
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle(),
  );
  if (!p) {
    document.title = "Post not found — Albert Iorbee Tersugh";
    message("message", "This post is unavailable or has not been published.");
    return;
  }
  document.title = p.title + " — Albert Iorbee Tersugh";
  document.querySelector('meta[name="description"]').content = p.excerpt || "";
  document.querySelector('meta[property="og:title"]').content = p.title;
  document.querySelector('meta[property="og:description"]').content =
    p.excerpt || "";
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = location.origin + "/blog/" + encodeURIComponent(p.slug);
  document.head.append(canonical);
  $("post-title").textContent = p.title;
  $("post-excerpt").textContent = p.excerpt;
  $("post-date").textContent = date(p.published_at);
  $("post-tags").textContent = Array.isArray(p.tags) ? p.tags.join(" · ") : "";
  $("post-content").innerHTML = cleanHTML(p.content);
  const cover = safeImage(p.cover_image_url);
  if (cover) {
    $("cover").src = cover;
    $("cover").hidden = false;
  }
  $("post").hidden = false;
  message("message", "");
  const count = async () => {
    const n = unwrap(await db.rpc("get_post_like_count", { p_post_id: p.id }));
    if (!/^\d+$/.test(String(n))) throw Error("Unexpected like count");
    message("like-count", `${n} ${String(n) === "1" ? "like" : "likes"}`);
  };
  try {
    if (localStorage.getItem("blog-liked-" + p.id)) {
      $("like").disabled = true;
      $("like").textContent = "Liked";
    }
  } catch {
    message("like-message", "Local storage is required to remember your like.");
  }
  $("like").onclick = async () => {
    $("like").disabled = true;
    try {
      let id;
      try {
        id = visitor();
      } catch {
        throw Error("Enable local storage to like this post.");
      }
      const result = await db
        .from("likes")
        .insert({ post_id: p.id, visitor_id: id });
      if (result.error && result.error.code !== "23505")
        throw Error("Could not save your like. Try again.");
      try {
        localStorage.setItem("blog-liked-" + p.id, "1");
      } catch {}
      $("like").textContent = "Liked";
      message(
        "like-message",
        result.error ? "You already liked this post." : "Thanks for reading.",
      );
      try {
        await count();
      } catch {
        message("like-count", "Like saved; count unavailable.");
      }
    } catch (e) {
      message("like-message", e.message);
      $("like").disabled = false;
    }
  };
  let commentOffset = 0;
  const comments = async () => {
    // RPC projection deliberately excludes email even if its contract expands later.
    const rows = unwrap(
      await db
        .rpc("get_public_comments", { p_post_id: p.id })
        .select("id,name,content,created_at")
        .order("created_at")
        .order("id")
        .range(commentOffset, commentOffset + 19),
    );
    for (const c of rows) {
      const row = element("article", undefined, "comment");
      row.append(
        element("strong", c.name),
        element("p", c.content),
        element("time", date(c.created_at)),
      );
      $("comments").append(row);
    }
    commentOffset += rows.length;
    $("more-comments").hidden = rows.length < 20;
    message(
      "comments-message",
      commentOffset ? "" : "No approved comments yet.",
    );
  };
  $("more-comments").onclick = () =>
    busy($("more-comments"), async () => {
      try {
        await comments();
      } catch {
        message("comments-message", "Comments unavailable. Try again.");
      }
    });
  $("comment-form").onsubmit = (event) => {
    event.preventDefault();
    busy(
      event.submitter || $("comment-form").querySelector("button[type=submit]"),
      async () => {
        try {
          const name = bounded($("name").value, 2, 80, "Name");
          const email = bounded($("email").value, 3, 254, "Email");
          const content = bounded($("comment").value, 3, 3000, "Comment");
          if (!$("email").validity.valid)
            throw Error("Enter a valid email address.");
          const result = await db
            .from("comments")
            .insert({ post_id: p.id, name, email, content, approved: false });
          if (result.error)
            throw Error(
              "Your comment could not be submitted. Please try again.",
            );
          $("comment-form").reset();
          message(
            "comment-message",
            "Thank you. Your comment is awaiting approval.",
          );
        } catch (e) {
          message("comment-message", e.message);
        }
      },
    );
  };
  // Wire forms before any optional RPC awaits, so slow RPCs cannot cause
  // a native form submission (and put a reader's email in the URL).
  await Promise.all([
    count().catch(() => message("like-count", "Like count unavailable.")),
    comments().catch(() =>
      message(
        "comments-message",
        "Comments unavailable. Please reload to try again.",
      ),
    ),
  ]);
}
try {
  db = client();
  await ($("posts") ? listing() : postPage());
} catch {
  message(
    "message",
    "The blog could not load. Please check your connection and reload.",
  );
}

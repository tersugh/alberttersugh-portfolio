import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { publicConfig } from "../scripts/config.mjs";
const config = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_ADMIN_USER_ID: "11111111-1111-4111-8111-111111111111",
};
test("build config accepts only explicitly publishable credentials", () => {
  assert.equal(publicConfig(config).key, "sb_publishable_test");
  for (const key of [
    "sb_secret_test",
    "eyJhbGciOiJIUzI1NiJ9.service_role.signature",
    "",
    "service_role",
  ])
    assert.throws(() =>
      publicConfig({ ...config, SUPABASE_PUBLISHABLE_KEY: key }),
    );
  assert.throws(() =>
    publicConfig({ ...config, SUPABASE_URL: "https://user:pass@example.com" }),
  );
  assert.throws(() =>
    publicConfig({ ...config, SUPABASE_URL: "http://example.com" }),
  );
  assert.equal(
    JSON.stringify(
      publicConfig({ ...config, SECRET: "must-not-appear" }),
    ).includes("must-not-appear"),
    false,
  );
});
test("rich text removes executable HTML and unsafe protocols", async () => {
  const dom = new JSDOM("");
  globalThis.window = dom.window;
  const { cleanHTML, slugValid, safeImage } = await import(
    "../assets/blog/shared.js"
  );
  const result = cleanHTML(
    '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)" onclick="alert(1)">click</a><p style="color:red">safe <strong>bold</strong></p><iframe src="https://evil.test"></iframe>',
  );
  assert.equal(result, "<a>click</a><p>safe <strong>bold</strong></p>");
  assert.equal(safeImage("javascript:alert(1)"), "");
  assert.equal(slugValid("../draft"), false);
  assert.equal(slugValid("hello-world"), true);
  dom.window.close();
});
const p = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Test <post>",
  slug: "test-post",
  excerpt: "A test excerpt",
  content: "<p>Hello <strong>reader</strong><img src=x onerror=alert(1)></p>",
  tags: ["code"],
  published_at: "2026-09-01T00:00:00Z",
};
async function publicPage(handler, path = "/blog/test-post", duringLoading) {
  const html = await readFile(
    path === "/blog" ? "blog/index.html" : "blog/post.html",
    "utf8",
  );
  const dom = new JSDOM(html, {
    url: "https://portfolio.test" + path,
    runScripts: "outside-only",
  });
  const w = dom.window;
  w.BLOG_CONFIG = publicConfig(config);
  w.Headers = Headers;
  w.Request = Request;
  w.Response = Response;
  w.AbortController = AbortController;
  w.fetch = async (url, init) => {
    const response = await handler(new URL(String(url)), init || {});
    return new Response(JSON.stringify(response.body), {
      status: response.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const bundle = await build({
    tsconfigRaw: {},
    entryPoints: ["assets/blog/public.js"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
  });
  // The production entry has top-level await but no exports; execute in an async closure.
  const execution = w.eval("(async()=>{" + bundle.outputFiles[0].text + "})()");
  if (duringLoading) await duringLoading(dom);
  await execution;
  return dom;
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Timed out");
}
test("post rendering uses anonymous published query, safe RPC and pending comment writes", async () => {
  const requests = [];
  let commentBody;
  const dom = await publicPage((url, init) => {
    requests.push([url, init]);
    if (url.pathname.endsWith("/posts")) return { body: p };
    if (url.pathname.endsWith("/get_post_like_count")) return { body: 3 };
    if (url.pathname.endsWith("/get_public_comments"))
      return {
        body: [
          {
            id: "1",
            name: "Reader",
            content: "<img src=x onerror=alert(1)>",
            created_at: p.published_at,
            email: "PRIVATE@example.com",
          },
        ],
      };
    if (url.pathname.endsWith("/comments")) {
      commentBody = JSON.parse(init.body);
      return { body: null, status: 201 };
    }
    if (url.pathname.endsWith("/likes"))
      return { body: { code: "23505", message: "duplicate" }, status: 409 };
    throw Error(url.href);
  });
  try {
    const d = dom.window.document;
    assert.equal(d.title, "Test <post> — Albert Iorbee Tersugh");
    assert.equal(d.querySelector("#post-content img"), null);
    assert.equal(d.querySelector("#comments img"), null);
    assert.equal(d.body.textContent.includes("PRIVATE@example.com"), false);
    const query = requests.find(([url]) => url.pathname.endsWith("/posts"));
    assert.equal(query[0].searchParams.get("status"), "eq.published");
    assert.equal(
      new Headers(query[1].headers).get("Authorization"),
      "Bearer sb_publishable_test",
    );
    const rpc = requests.find(([url]) =>
      url.pathname.endsWith("/get_public_comments"),
    )[0];
    assert.equal(rpc.searchParams.get("select"), "id,name,content,created_at");
    d.getElementById("name").value = "Tester";
    d.getElementById("email").value = "reader@example.com";
    d.getElementById("comment").value = "Useful article";
    const form = d.getElementById("comment-form");
    form.dispatchEvent(
      new dom.window.SubmitEvent("submit", {
        cancelable: true,
        submitter: form.querySelector("button"),
      }),
    );
    await until(() =>
      d
        .getElementById("comment-message")
        .textContent.includes("awaiting approval"),
    );
    assert.equal(commentBody.approved, false);
    assert.equal(commentBody.email, "reader@example.com");
    d.getElementById("like").click();
    await until(() => d.getElementById("like").textContent === "Liked");
    assert.equal(d.getElementById("like").disabled, true);
    assert.equal(dom.window.localStorage.getItem("blog-liked-" + p.id), "1");
  } finally {
    dom.window.close();
  }
});
test("unavailable/draft slug never renders post controls", async () => {
  const dom = await publicPage(() => ({ body: null }));
  assert.equal(dom.window.document.getElementById("post").hidden, true);
  assert.match(
    dom.window.document.getElementById("message").textContent,
    /unavailable/,
  );
  dom.window.close();
});
test("listing selects published posts without downloading body content", async () => {
  let query;
  const dom = await publicPage((url) => {
    query = url;
    return { body: [] };
  }, "/blog");
  assert.equal(query.searchParams.get("status"), "eq.published");
  assert.equal(query.searchParams.get("select").includes("content"), false);
  assert.match(
    dom.window.document.getElementById("message").textContent,
    /No posts/,
  );
  dom.window.close();
});
test("Vercel destinations exist and admin route precedes dynamic route", async () => {
  const config = JSON.parse(await readFile("vercel.json", "utf8"));
  for (const r of config.rewrites)
    assert.ok(
      (await readFile("." + r.destination, "utf8")).startsWith(
        "<!doctype html>",
      ),
    );
  assert.deepEqual(
    config.rewrites.map((r) => r.source),
    ["/admin/blog", "/blog", "/blog/:slug"],
  );
});
async function adminPage(handler) {
  const dom = new JSDOM(await readFile("admin/blog/index.html", "utf8"), {
    url: "https://portfolio.test/admin/blog",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.BLOG_CONFIG = publicConfig(config);
  w.Headers = Headers;
  w.Request = Request;
  w.Response = Response;
  w.AbortController = AbortController;
  w.confirm = () => true;
  w.fetch = async (url, init) => {
    const response = await handler(new URL(String(url)), init || {});
    return new Response(JSON.stringify(response.body), {
      status: response.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const bundle = await build({
    tsconfigRaw: {},
    entryPoints: ["assets/blog/admin.js"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
  });
  await w.eval("(async()=>{" + bundle.outputFiles[0].text + "})()");
  return dom;
}
function submit(w, id) {
  const form = w.document.getElementById(id);
  form.dispatchEvent(
    new w.SubmitEvent("submit", {
      cancelable: true,
      submitter: form.querySelector("button[type=submit]"),
    }),
  );
}
function authResponse(id) {
  return {
    access_token: "header.payload.signature",
    refresh_token: "refresh",
    expires_in: 3600,
    token_type: "bearer",
    user: { id, email: "admin@example.com" },
  };
}
test("admin login denies a different authenticated user without fetching content", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  let contentRequests = 0;
  const dom = await adminPage((url) => {
    if (url.pathname.endsWith("/token")) return { body: authResponse(id) };
    if (url.pathname.endsWith("/user"))
      return { body: { id, email: "other@example.com" } };
    if (url.pathname.endsWith("/logout")) return { body: {} };
    contentRequests++;
    return { body: [] };
  });
  try {
    const w = dom.window,
      d = w.document;
    assert.equal(d.getElementById("login").hidden, false);
    d.getElementById("login-email").value = "other@example.com";
    d.getElementById("password").value = "test-password";
    submit(w, "login");
    await until(() =>
      d.getElementById("message").textContent.includes("not authorized"),
    );
    assert.equal(d.getElementById("desk").hidden, true);
    assert.equal(contentRequests, 0);
  } finally {
    dom.window.close();
  }
});
test("authorized admin saves sanitized published content and rejects a stale update", async () => {
  const id = config.SUPABASE_ADMIN_USER_ID;
  let writes = [];
  let savedPost = { ...p, status: "draft", updated_at: "2026-09-01T00:00:00Z" };
  const dom = await adminPage((url, init) => {
    if (url.pathname.endsWith("/token")) return { body: authResponse(id) };
    if (url.pathname.endsWith("/user"))
      return { body: { id, email: "admin@example.com" } };
    if (url.pathname.endsWith("/comments")) return { body: [] };
    if (url.pathname.endsWith("/posts")) {
      if (init.method === "PATCH") {
        writes.push([url, JSON.parse(init.body)]);
        return { body: [] };
      }
      if (init.method === "POST") {
        const data = JSON.parse(init.body);
        writes.push([url, data]);
        savedPost = { ...data };
        return { body: [savedPost] };
      }
      if (url.searchParams.get("id")) return { body: savedPost };
      return { body: [] };
    }
    throw Error(url.href);
  });
  try {
    const w = dom.window,
      d = w.document;
    d.getElementById("login-email").value = "admin@example.com";
    d.getElementById("password").value = "test-password";
    submit(w, "login");
    await until(() => !d.getElementById("desk").hidden);
    await until(() =>
      d.getElementById("post-list").textContent.includes("No posts"),
    );
    d.getElementById("title").value = "A new post";
    d.getElementById("slug").value = "a-new-post";
    d.getElementById("excerpt").value = "An excerpt";
    const editor = d.querySelector(".ql-editor");
    editor.innerHTML = "<p>Hello <strong>world</strong></p>";
    editor.dispatchEvent(
      new w.InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const form = d.getElementById("post-form");
    const publish = form.querySelector("button[value=published]");
    form.dispatchEvent(
      new w.SubmitEvent("submit", { cancelable: true, submitter: publish }),
    );
    await until(
      () => d.getElementById("save-message").textContent === "Published.",
    );
    assert.equal(writes[0][1].status, "published");
    assert.match(writes[0][1].content, /<strong>world<\/strong>/);
    assert.ok(writes[0][1].published_at);
    await until(() => !publish.disabled);
    form.dispatchEvent(
      new w.SubmitEvent("submit", { cancelable: true, submitter: publish }),
    );
    await until(() =>
      d
        .getElementById("save-message")
        .textContent.includes("changed in another session"),
    );
    assert.equal(
      writes[1][0].searchParams.get("updated_at"),
      "eq." + savedPost.updated_at,
    );
  } finally {
    dom.window.close();
  }
});
async function loginAdmin(dom) {
  const w = dom.window,
    d = w.document;
  d.getElementById("login-email").value = "admin@example.com";
  d.getElementById("password").value = "test-password";
  submit(w, "login");
  await until(() => !d.getElementById("desk").hidden);
  await until(
    () =>
      d.getElementById("moderation-message").textContent ===
      "No pending comments.",
  );
}
test("cover replacement commits its reference before deleting old storage, then supports removal", async () => {
  const id = config.SUPABASE_ADMIN_USER_ID,
    events = [];
  const old = `https://example.supabase.co/storage/v1/object/public/blog-covers/${p.id}/old.jpg`;
  let stored = {
    ...p,
    status: "published",
    updated_at: "2026-09-01T00:00:00Z",
    cover_image_url: old,
  };
  const dom = await adminPage((url, init) => {
    if (url.pathname.endsWith("/token")) return { body: authResponse(id) };
    if (url.pathname.endsWith("/user")) return { body: { id } };
    if (url.pathname.endsWith("/comments")) return { body: [] };
    if (url.pathname.includes("/storage/")) {
      events.push([
        init.method,
        url.pathname,
        init.method === "DELETE" ? JSON.parse(init.body) : null,
      ]);
      return { body: { Key: "cover" } };
    }
    if (url.pathname.endsWith("/posts")) {
      if (init.method === "PATCH") {
        events.push(["save"]);
        stored = { ...stored, ...JSON.parse(init.body) };
        return { body: [stored] };
      }
      return { body: url.searchParams.get("id") ? stored : [stored] };
    }
    throw Error(url.href);
  });
  try {
    await loginAdmin(dom);
    const w = dom.window,
      d = w.document;
    d.querySelector("#post-list button").click();
    await until(() => d.getElementById("title").value === p.title);
    const file = new w.File(["image bytes"], "cover.webp", {
      type: "image/webp",
    });
    Object.defineProperty(d.getElementById("cover-file"), "files", {
      configurable: true,
      value: [file],
    });
    const form = d.getElementById("post-form"),
      publish = form.querySelector("[value=published]");
    form.dispatchEvent(
      new w.SubmitEvent("submit", { cancelable: true, submitter: publish }),
    );
    await until(
      () => d.getElementById("save-message").textContent === "Published.",
    );
    await until(() => !publish.disabled);
    assert.equal(events[0][0], "POST");
    assert.equal(events[1][0], "save");
    assert.equal(events[2][0], "DELETE");
    assert.deepEqual(events[2][2].prefixes, [p.id + "/old.jpg"]);
    assert.notEqual(stored.cover_image_url, old);
    Object.defineProperty(d.getElementById("cover-file"), "files", {
      configurable: true,
      value: [],
    });
    d.getElementById("remove-cover").click();
    form.dispatchEvent(
      new w.SubmitEvent("submit", { cancelable: true, submitter: publish }),
    );
    await until(() => !publish.disabled);
    assert.equal(stored.cover_image_url, null);
    assert.deepEqual(
      events.slice(3).map((e) => e[0]),
      ["save", "DELETE"],
    );
  } finally {
    dom.window.close();
  }
});
test("pending comment actions approve and delete only the selected pending row", async () => {
  const id = config.SUPABASE_ADMIN_USER_ID,
    writes = [];
  const comments = [
    {
      id: "1",
      post_id: p.id,
      name: "One",
      content: "Pending one",
      created_at: p.published_at,
    },
    {
      id: "2",
      post_id: p.id,
      name: "Two",
      content: "Pending two",
      created_at: p.published_at,
    },
  ];
  const dom = await adminPage((url, init) => {
    if (url.pathname.endsWith("/token")) return { body: authResponse(id) };
    if (url.pathname.endsWith("/user")) return { body: { id } };
    if (url.pathname.endsWith("/posts")) return { body: [] };
    if (url.pathname.endsWith("/comments")) {
      if (init.method === "PATCH" || init.method === "DELETE") {
        writes.push([url, init]);
        return { body: [{ id: url.searchParams.get("id").slice(3) }] };
      }
      return { body: comments };
    }
    throw Error(url.href);
  });
  try {
    const w = dom.window,
      d = w.document;
    d.getElementById("login-email").value = "admin@example.com";
    d.getElementById("password").value = "test-password";
    submit(w, "login");
    await until(() => d.querySelectorAll("#pending article").length === 2);
    d.querySelector("#pending article button").click();
    await until(() => d.querySelectorAll("#pending article").length === 1);
    d.querySelectorAll("#pending article button")[1].click();
    await until(() => d.querySelectorAll("#pending article").length === 0);
    assert.equal(writes[0][0].searchParams.get("approved"), "eq.false");
    assert.deepEqual(JSON.parse(writes[0][1].body), { approved: true });
    assert.equal(writes[1][1].method, "DELETE");
    assert.equal(writes[1][0].searchParams.get("id"), "eq.2");
  } finally {
    dom.window.close();
  }
});

test("slow public RPCs do not allow native comment submission", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const dom = await publicPage(
    async (url) => {
      if (url.pathname.endsWith("/posts")) return { body: p };
      if (url.pathname.endsWith("/get_post_like_count")) {
        await pending;
        return { body: 0 };
      }
      if (url.pathname.endsWith("/get_public_comments")) return { body: [] };
      if (url.pathname.endsWith("/comments"))
        return { body: null, status: 201 };
      throw Error(url.href);
    },
    "/blog/test-post",
    async (dom) => {
      try {
        const w = dom.window,
          d = w.document;
        await until(() => !d.getElementById("post").hidden);
        d.getElementById("name").value = "Tester";
        d.getElementById("email").value = "private@example.com";
        d.getElementById("comment").value = "A useful article";
        const form = d.getElementById("comment-form");
        const event = new w.SubmitEvent("submit", {
          cancelable: true,
          submitter: form.querySelector("button"),
        });
        form.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        await until(() =>
          d
            .getElementById("comment-message")
            .textContent.includes("awaiting approval"),
        );
        assert.equal(w.location.search, "");
      } finally {
        release();
      }
    },
  );
  dom.window.close();
});

async function deleteFixture({
  confirm = true,
  result = "success",
  cover,
  updatedAt = "2026-09-01T00:00:00Z",
  storageFails = false,
  deleteWait,
  saveWait,
  refreshFails = false,
} = {}) {
  const id = config.SUPABASE_ADMIN_USER_ID;
  const post = {
    ...p,
    status: "published",
    updated_at: updatedAt,
    cover_image_url:
      cover === undefined
        ? `https://example.supabase.co/storage/v1/object/public/blog-covers/${p.id}/cover.jpg`
        : cover,
  };
  const requests = [],
    confirmations = [];
  let deleted = false,
    listReads = 0;
  const dom = await adminPage(async (url, init) => {
    requests.push({ url, method: init.method || "GET", body: init.body });
    if (url.pathname.endsWith("/token")) return { body: authResponse(id) };
    if (url.pathname.endsWith("/user")) return { body: { id } };
    if (url.pathname.endsWith("/comments")) return { body: [] };
    if (url.pathname.includes("/storage/"))
      return storageFails
        ? { status: 403, body: { message: "Sensitive Storage error" } }
        : { body: [] };
    if (url.pathname.endsWith("/posts")) {
      if (init.method === "DELETE") {
        if (deleteWait) await deleteWait;
        if (result === "error")
          return {
            status: 403,
            body: { message: "Sensitive database error", code: "42501" },
          };
        if (result === "missing") return { body: [] };
        deleted = true;
        return {
          body: [{ id: post.id, cover_image_url: post.cover_image_url }],
        };
      }
      if (init.method === "PATCH") {
        if (saveWait) await saveWait;
        return { body: [{ ...post, ...JSON.parse(init.body) }] };
      }
      if (url.searchParams.has("id")) return { body: post };
      listReads++;
      if (deleted && refreshFails)
        return { status: 403, body: { message: "List unavailable" } };
      return { body: deleted ? [] : [post] };
    }
    throw Error(url.href);
  });
  dom.window.confirm = (text) => {
    confirmations.push(text);
    return confirm;
  };
  await loginAdmin(dom);
  return {
    dom,
    d: dom.window.document,
    post,
    requests,
    confirmations,
    listReads: () => listReads,
  };
}
async function openDeletePost(fixture) {
  fixture.d.querySelector("#post-list button").click();
  await until(
    () => fixture.d.getElementById("title").value === fixture.post.title,
  );
}
function postDeletes(fixture) {
  return fixture.requests.filter(
    (r) => r.method === "DELETE" && r.url.pathname.endsWith("/posts"),
  );
}
function storageDeletes(fixture) {
  return fixture.requests.filter(
    (r) => r.method === "DELETE" && r.url.pathname.includes("/storage/"),
  );
}
async function deleteFinished(fixture) {
  await until(() => !fixture.d.getElementById("delete-post").disabled);
}

test("delete action is hidden for an unsaved post, visible when loaded, and cancellation keeps dirty edits", async () => {
  const f = await deleteFixture({ confirm: false });
  try {
    assert.equal(f.d.getElementById("delete-post-action").hidden, true);
    await openDeletePost(f);
    assert.equal(f.d.getElementById("delete-post-action").hidden, false);
    f.d.getElementById("title").value = "Unsaved edit";
    f.d
      .getElementById("title")
      .dispatchEvent(new f.dom.window.Event("input", { bubbles: true }));
    f.d.getElementById("delete-post").click();
    assert.equal(postDeletes(f).length, 0);
    assert.equal(storageDeletes(f).length, 0);
    assert.equal(f.d.getElementById("title").value, "Unsaved edit");
    assert.match(f.confirmations[0], /Permanently delete/);
    assert.ok(f.confirmations[0].includes(f.post.title));
    assert.match(f.confirmations[0], /comments and likes/);
    assert.match(f.confirmations[0], /unsaved changes will also be lost/);
  } finally {
    f.dom.window.close();
  }
});

test("confirmed deletion is scoped by ID and timestamp, cleans storage afterwards, resets and refreshes", async () => {
  const f = await deleteFixture();
  try {
    await openDeletePost(f);
    const reads = f.listReads();
    f.d.getElementById("delete-post").click();
    await deleteFinished(f);
    assert.equal(postDeletes(f).length, 1);
    const deletion = postDeletes(f)[0];
    assert.equal(deletion.url.searchParams.get("id"), "eq." + f.post.id);
    assert.equal(
      deletion.url.searchParams.get("updated_at"),
      "eq." + f.post.updated_at,
    );
    assert.equal(storageDeletes(f).length, 1);
    assert.ok(
      f.requests.indexOf(deletion) < f.requests.indexOf(storageDeletes(f)[0]),
    );
    assert.deepEqual(JSON.parse(storageDeletes(f)[0].body).prefixes, [
      f.post.id + "/cover.jpg",
    ]);
    assert.equal(f.d.getElementById("title").value, "");
    assert.equal(f.d.querySelector(".ql-editor").textContent.trim(), "");
    assert.equal(f.d.getElementById("delete-post-action").hidden, true);
    assert.equal(
      f.d.getElementById("save-message").textContent,
      "Post deleted permanently.",
    );
    assert.ok(f.listReads() > reads);
    assert.match(f.d.getElementById("post-list").textContent, /No posts yet/);
    assert.equal(
      f.requests.filter(
        (r) =>
          r.method === "DELETE" && /\/(comments|likes)$/.test(r.url.pathname),
      ).length,
      0,
    );
  } finally {
    f.dom.window.close();
  }
});

for (const result of ["error", "missing"]) {
  test(`database ${result} never deletes Storage or discards the loaded editor`, async () => {
    const f = await deleteFixture({ result });
    try {
      await openDeletePost(f);
      f.d.getElementById("delete-post").click();
      await deleteFinished(f);
      assert.equal(storageDeletes(f).length, 0);
      assert.equal(f.d.getElementById("title").value, f.post.title);
      assert.equal(f.d.getElementById("delete-post-action").hidden, false);
      assert.match(
        f.d.getElementById("save-message").textContent,
        /[Rr]eopen or refresh/,
      );
      assert.equal(
        f.d.body.textContent.includes("Sensitive database error"),
        false,
      );
    } finally {
      f.dom.window.close();
    }
  });
}

test("Storage failure leaves the post deleted, resets the editor, refreshes and warns safely", async () => {
  const f = await deleteFixture({ storageFails: true });
  try {
    await openDeletePost(f);
    f.d.getElementById("delete-post").click();
    await deleteFinished(f);
    assert.equal(f.d.getElementById("delete-post-action").hidden, true);
    assert.equal(f.d.getElementById("title").value, "");
    assert.match(f.d.getElementById("post-list").textContent, /No posts yet/);
    assert.match(
      f.d.getElementById("save-message").textContent,
      /Post deleted permanently.*manual removal from Storage/,
    );
    assert.equal(
      f.requests.some(
        (r) =>
          ["POST", "PATCH"].includes(r.method) &&
          r.url.pathname.endsWith("/posts"),
      ),
      false,
    );
    assert.equal(
      f.d.body.textContent.includes("Sensitive Storage error"),
      false,
    );
  } finally {
    f.dom.window.close();
  }
});

for (const cover of [
  null,
  "https://external.test/image.jpg",
  "https://example.supabase.co/storage/v1/object/public/blog-covers/legacy.jpg",
]) {
  test(`deletion does not remove unowned cover: ${cover || "no cover"}`, async () => {
    const f = await deleteFixture({ cover, updatedAt: null });
    try {
      await openDeletePost(f);
      f.d.getElementById("delete-post").click();
      await deleteFinished(f);
      assert.equal(
        postDeletes(f)[0].url.searchParams.get("updated_at"),
        "is.null",
      );
      assert.equal(storageDeletes(f).length, 0);
      assert.match(
        f.d.getElementById("save-message").textContent,
        /^Post deleted permanently/,
      );
    } finally {
      f.dom.window.close();
    }
  });
}

test("deletion locks controls and prevents duplicate deletes and overlapping saves", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const f = await deleteFixture({ deleteWait: wait });
  try {
    await openDeletePost(f);
    f.d.getElementById("delete-post").click();
    await until(() => postDeletes(f).length === 1);
    assert.equal(f.d.getElementById("title").disabled, true);
    assert.equal(
      f.d.querySelector(".ql-editor").getAttribute("contenteditable"),
      "false",
    );
    f.d.getElementById("delete-post").onclick();
    const form = f.d.getElementById("post-form");
    form.dispatchEvent(
      new f.dom.window.SubmitEvent("submit", {
        cancelable: true,
        submitter: form.querySelector("[value=published]"),
      }),
    );
    assert.equal(postDeletes(f).length, 1);
    assert.equal(f.confirmations.length, 1);
    assert.equal(
      f.requests.some((r) => r.method === "PATCH"),
      false,
    );
    release();
    await deleteFinished(f);
  } finally {
    release();
    f.dom.window.close();
  }
});

test("delete cannot start while saving, and a failed list refresh does not undo deletion", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const f = await deleteFixture({ saveWait: wait, refreshFails: true });
  try {
    await openDeletePost(f);
    const form = f.d.getElementById("post-form");
    const publish = form.querySelector("[value=published]");
    form.dispatchEvent(
      new f.dom.window.SubmitEvent("submit", {
        cancelable: true,
        submitter: publish,
      }),
    );
    await until(() => f.requests.some((r) => r.method === "PATCH"));
    f.d.getElementById("delete-post").onclick();
    assert.equal(postDeletes(f).length, 0);
    assert.equal(f.confirmations.length, 0);
    release();
    await until(() => !publish.disabled);
    f.d.getElementById("delete-post").click();
    await deleteFinished(f);
    assert.match(
      f.d.getElementById("save-message").textContent,
      /Post deleted permanently.*lists could not refresh/,
    );
    assert.equal(f.d.getElementById("title").value, "");
  } finally {
    release();
    f.dom.window.close();
  }
});

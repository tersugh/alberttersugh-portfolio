import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const adminId = "11111111-1111-4111-8111-111111111111";
const ok = (data) => ({ data, error: null });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw Error("Timed out waiting for recovery UI");
}

// Control auth-event timing while retaining the real editor and UI helpers.
const bundle = await build({
  tsconfigRaw: {},
  entryPoints: ["assets/blog/admin.js"],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  plugins: [
    {
      name: "recovery-auth-fixture",
      setup(build) {
        build.onResolve({ filter: /^\.\/shared\.js$/ }, () => ({
          path: "shared",
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `export * from ${JSON.stringify(resolve("assets/blog/shared.js"))}; export const client = () => window.testClient;`,
          resolveDir: process.cwd(),
        }));
      },
    },
  ],
});

async function recoveryPage({
  userId = adminId,
  update = async () => ok({ user: { id: userId } }),
} = {}) {
  const dom = new JSDOM(await readFile("admin/blog/index.html", "utf8"), {
    url: "https://portfolio.test/admin/blog",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window,
    d = w.document;
  const initialUser = deferred();
  let onAuthChange,
    reads = 0,
    updates = 0;
  w.BLOG_CONFIG = { admin: adminId };
  w.testClient = {
    auth: {
      getUser: () =>
        ++reads === 1
          ? initialUser.promise
          : Promise.resolve(ok({ user: { id: userId } })),
      onAuthStateChange: (callback) => {
        onAuthChange = callback;
      },
      updateUser: async (attributes) => {
        updates++;
        assert.equal(typeof attributes.password, "string");
        return update(attributes);
      },
      signOut: async () => {
        onAuthChange("SIGNED_OUT");
        return ok(null);
      },
    },
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range: async () => ok([]),
      };
      return query;
    },
  };
  const execution = w.eval("(async()=>{" + bundle.outputFiles[0].text + "})()");
  await until(() => !!onAuthChange);
  onAuthChange("PASSWORD_RECOVERY");
  initialUser.resolve(ok({ user: { id: userId } }));
  await execution;
  return {
    dom,
    w,
    d,
    emit: (event) => onAuthChange(event),
    updates: () => updates,
  };
}
function submit(page, password, confirmation = password) {
  const { w, d } = page;
  d.getElementById("new-password").value = password;
  d.getElementById("confirm-password").value = confirmation;
  const form = d.getElementById("recovery");
  const event = new w.SubmitEvent("submit", {
    cancelable: true,
    submitter: form.querySelector("button"),
  });
  form.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

test("recovery overrides an in-flight session check, validates passwords and restores the authorized desk", async () => {
  const page = await recoveryPage();
  try {
    const { d } = page;
    assert.equal(d.getElementById("desk").hidden, true);
    assert.equal(d.getElementById("login").hidden, true);
    assert.equal(d.getElementById("recovery").hidden, false);
    assert.equal(
      d.getElementById("message").textContent,
      "Choose a new password.",
    );
    submit(page, "short");
    assert.match(
      d.getElementById("recovery-message").textContent,
      /at least 8/,
    );
    submit(page, "test-password", "does-not-match");
    assert.match(
      d.getElementById("recovery-message").textContent,
      /must match/,
    );
    assert.equal(page.updates(), 0);
    submit(page, "test-password");
    await until(() => !d.getElementById("desk").hidden);
    assert.equal(page.updates(), 1);
    assert.equal(d.getElementById("recovery").hidden, true);
    assert.equal(d.getElementById("login").hidden, true);
    assert.equal(d.getElementById("new-password").value, "");
    assert.equal(d.getElementById("confirm-password").value, "");
    assert.equal(d.getElementById("message").textContent, "Password updated.");
  } finally {
    page.dom.window.close();
  }
});

test("failed recovery updates show a safe error and allow retry", async () => {
  const page = await recoveryPage({
    update: async () => ({
      data: null,
      error: Error("Sensitive backend details"),
    }),
  });
  try {
    submit(page, "test-password");
    await until(() => !page.d.querySelector("#recovery button").disabled);
    assert.equal(
      page.d.getElementById("recovery-message").textContent,
      "Could not update the password. Request a new recovery link and try again.",
    );
    assert.equal(page.d.getElementById("recovery").hidden, false);
    assert.equal(page.d.getElementById("desk").hidden, true);
    assert.equal(
      page.d.body.textContent.includes("Sensitive backend details"),
      false,
    );
  } finally {
    page.dom.window.close();
  }
});

test("sign-out during recovery clears dirty/password state and wins over a pending update", async () => {
  const pending = deferred();
  const page = await recoveryPage({ update: () => pending.promise });
  try {
    const { w, d } = page;
    d.getElementById("title").dispatchEvent(
      new w.Event("input", { bubbles: true }),
    );
    submit(page, "test-password");
    page.emit("SIGNED_OUT");
    pending.resolve(ok({ user: { id: adminId } }));
    await until(() => !d.querySelector("#recovery button").disabled);
    assert.equal(d.getElementById("recovery").hidden, true);
    assert.equal(d.getElementById("desk").hidden, true);
    assert.equal(d.getElementById("login").hidden, false);
    assert.equal(d.getElementById("new-password").value, "");
    assert.equal(d.getElementById("confirm-password").value, "");
    assert.equal(
      d.getElementById("message").textContent,
      "Session ended. Sign in again.",
    );
    const leave = new w.Event("beforeunload", { cancelable: true });
    w.dispatchEvent(leave);
    assert.equal(leave.defaultPrevented, false);
  } finally {
    page.dom.window.close();
  }
});

test("a recovered non-admin user still cannot open the publishing desk", async () => {
  const page = await recoveryPage({
    userId: "22222222-2222-4222-8222-222222222222",
  });
  try {
    submit(page, "test-password");
    await until(() => !page.d.querySelector("#recovery button").disabled);
    assert.equal(page.d.getElementById("desk").hidden, true);
    assert.equal(page.d.getElementById("login").hidden, false);
    assert.equal(page.d.getElementById("recovery").hidden, true);
    assert.match(
      page.d.getElementById("message").textContent,
      /not authorized/,
    );
  } finally {
    page.dom.window.close();
  }
});

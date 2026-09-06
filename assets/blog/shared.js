import { createClient } from "@supabase/supabase-js";
import DOMPurify from "dompurify";
export const $ = (id) => document.getElementById(id);
export function client(admin = false) {
  const c = window.BLOG_CONFIG;
  if (!c?.url || !c?.key)
    throw Error("Blog configuration is missing. Please try again later.");
  return createClient(c.url, c.key, {
    auth: {
      persistSession: admin,
      autoRefreshToken: admin,
      detectSessionInUrl: admin,
      storageKey: "portfolio-blog-admin",
    },
  });
}
export function unwrap(result) {
  if (result.error) throw result.error;
  return result.data;
}
export function cleanHTML(html) {
  return DOMPurify.sanitize(html || "", {
    ALLOWED_TAGS: [
      "p",
      "br",
      "h2",
      "h3",
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
    ],
    ALLOWED_ATTR: ["href", "title"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
export function safeImage(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}
export function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
export function date(value) {
  return value
    ? new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";
}
export function message(id, text) {
  $(id).textContent = text;
}
export function failure(error) {
  return error?.code === "23505"
    ? "That slug is already used. Choose a different slug."
    : "The request could not be completed. Check your connection and permissions, then try again.";
}
export function bounded(value, min, max, label) {
  const v = value.trim();
  if (v.length < min || v.length > max)
    throw Error(`${label} must contain ${min}–${max} characters.`);
  return v;
}
export function slugValid(value) {
  return value.length <= 120 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
export function coverPath(url) {
  try {
    const base = new URL(window.BLOG_CONFIG.url);
    const u = new URL(url);
    const prefix = "/storage/v1/object/public/blog-covers/";
    if (u.origin !== base.origin || !u.pathname.startsWith(prefix)) return null;
    return decodeURIComponent(u.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}
export async function busy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

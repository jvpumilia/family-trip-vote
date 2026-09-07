import { corsHeaders, json, err } from "../_shared/cors.ts";
import { adminClient } from "../_shared/supa.ts";

const HOUSEHOLDS = ["Southwest Florida", "Gig Harbor, WA", "Nashville, TN", "Rockford, IL", "Janesville, WI", "Other"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || "").trim();
    const household = String(body.household || "").trim();
    const invite = String(body.invite || "").trim();

    const expected = (Deno.env.get("INVITE_CODE") || "").trim();
    if (!expected || invite.toLowerCase() !== expected.toLowerCase()) return err("That family code is not right. Ask Joseph for it.", 403);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Please enter a valid email address.");
    if (password.length < 8) return err("Password needs at least 8 characters.");
    if (name.length < 2) return err("Please tell us your name.");
    if (!HOUSEHOLDS.includes(household)) return err("Pick which family group you are with.");

    const admin = adminClient();
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { name, household },
    });
    if (error) {
      if (/already|exists|registered/i.test(error.message)) return err("That email already has an account. Sign in instead, or ask Joseph to reset your password.", 409);
      return err(error.message, 400);
    }
    const admins = (Deno.env.get("ADMIN_EMAILS") || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const { error: perr } = await admin.from("profiles").insert({
      id: created.user.id, email, display_name: name, household, is_admin: admins.includes(email),
    });
    if (perr) return err("Account made but profile failed: " + perr.message, 500);
    return json({ ok: true });
  } catch (e) {
    return err((e as Error).message || "Signup failed", 500);
  }
});

import { corsHeaders, json, err } from "../_shared/cors.ts";
import { adminClient, requireUser } from "../_shared/supa.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { user, profile } = await requireUser(req);
    if (!user) return err("Please sign in.", 401);
    if (!profile?.is_admin) return err("Admins only.", 403);
    const body = await req.json();
    const admin = adminClient();

    if (body.action === "reset_password") {
      const email = String(body.email || "").trim().toLowerCase();
      const pw = String(body.password || "");
      if (pw.length < 8) return err("Password needs at least 8 characters.");
      const { data: prof } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      if (!prof) return err("No account with that email.", 404);
      const { error } = await admin.auth.admin.updateUserById(prof.id, { password: pw });
      if (error) return err(error.message, 500);
      return json({ ok: true });
    }
    if (body.action === "set_admin") {
      const { error } = await admin.from("profiles").update({ is_admin: !!body.is_admin }).eq("id", body.user_id);
      if (error) return err(error.message, 500);
      return json({ ok: true });
    }
    if (body.action === "delete_user") {
      if (body.user_id === user.id) return err("You cannot delete yourself.");
      const { error } = await admin.auth.admin.deleteUser(body.user_id);
      if (error) return err(error.message, 500);
      return json({ ok: true });
    }
    return err("Unknown action");
  } catch (e) {
    return err((e as Error).message || "Failed", 500);
  }
});

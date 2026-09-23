"use server";

import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";

export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  if (await signIn(password)) redirect("/");
  redirect("/login?error=1");
}

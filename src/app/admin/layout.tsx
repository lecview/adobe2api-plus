import { AdminShell } from "@/components/admin-shell";
import { getCurrentAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  if (!(await getCurrentAdmin())) redirect("/login");
  return <AdminShell>{children}</AdminShell>;
}

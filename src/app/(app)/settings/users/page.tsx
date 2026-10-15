import { redirect } from "next/navigation";

/** Team management lives at /team (in the main navigation); old links to Settings → Users land there. */
export default function UsersPage() {
  redirect("/team");
}

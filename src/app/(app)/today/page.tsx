import { PageHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";

export const metadata = { title: "Today" };

export default async function TodayPage() {
  const user = await requireUser();
  return <PageHeader title={`Good day, ${user.name.split(" ")[0]}`} description="Your ranked queue appears here." />;
}

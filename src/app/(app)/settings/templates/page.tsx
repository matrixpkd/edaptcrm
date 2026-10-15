import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { SettingsHeader } from "../_components/settings-header";
import { TemplatesEditor } from "./templates-editor";

export const metadata = { title: "Message templates" };

export default async function TemplatesPage() {
  await requireUser(["admin"]);
  const templates = await getSetting("templates.whatsapp");
  return (
    <div className="mx-auto max-w-3xl">
      <SettingsHeader
        title="Message templates"
        description="Ready-made WhatsApp messages. On a contact, WhatsApp offers these with the person's details filled in; the salesperson still sends each one from their own WhatsApp."
      />
      <Card>
        <CardHeader
          title="WhatsApp templates"
          description="Placeholders: {name}, {first_name}, {offer} (their next best offer) and {owner} (the person sending)."
        />
        <CardBody>
          <TemplatesEditor initial={templates} />
        </CardBody>
      </Card>
    </div>
  );
}

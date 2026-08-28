import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Inbox } from "lucide-react";

/** Route foundation registered with the landing-page setting. The durable
 * queue and result panes are added by the cockpit implementation. */
export function ReviewInboxPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Review inbox" subtitle="Private automatic review results" />
      <EmptyState
        icon={Inbox}
        title="No prepared reviews yet"
        description="Enable a repository in Settings. New review requests will appear here after the local review finishes."
        className="flex-1"
      />
    </div>
  );
}

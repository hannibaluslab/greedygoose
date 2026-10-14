import { notFound } from "next/navigation";
import { FRIENDS_ENABLED } from "@/lib/features";
import { Friends } from "./Friends";

/** Friends tab (D16), behind NEXT_PUBLIC_FRIENDS. A 404 when it's off. */
export default function FriendsPage() {
  if (!FRIENDS_ENABLED) notFound();
  return <Friends />;
}

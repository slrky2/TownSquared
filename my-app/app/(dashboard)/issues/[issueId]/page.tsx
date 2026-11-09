// Issue detail view — map preview, status timeline, upvotes, city response
interface Props {
  params: Promise<{ issueId: string }>;
}

export default async function IssueDetailPage({ params }: Props) {
  const { issueId } = await params;
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Issue #{issueId}</h1>
      {/* TODO: render IssueDetail */}
    </div>
  );
}

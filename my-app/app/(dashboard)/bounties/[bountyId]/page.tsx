// Bounty detail view — requirements, reward, claim button
interface Props {
  params: Promise<{ bountyId: string }>;
}

export default async function BountyDetailPage({ params }: Props) {
  const { bountyId } = await params;
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Bounty #{bountyId}</h1>
      {/* TODO: render BountyDetail */}
    </div>
  );
}

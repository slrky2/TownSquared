// Individual channel view — message thread + member list
interface Props {
  params: Promise<{ channelId: string }>;
}

export default async function ChannelPage({ params }: Props) {
  const { channelId } = await params;
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Channel: {channelId}</h1>
      {/* TODO: render MessageThread and MessageInput */}
    </div>
  );
}

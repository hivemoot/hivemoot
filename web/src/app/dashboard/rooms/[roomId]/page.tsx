import RoomDetail from "./RoomDetail";

export default async function RoomDetailPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return <RoomDetail roomId={roomId} />;
}

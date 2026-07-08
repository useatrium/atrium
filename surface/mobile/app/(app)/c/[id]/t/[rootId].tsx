import { Redirect, useLocalSearchParams, type Href } from 'expo-router';
import { firstRouteParam, inboundQueryParams } from '../../../../../src/lib/deepLinkRoutes';

export default function ChannelThreadAliasRoute() {
  const params = useLocalSearchParams<{
    id?: string;
    rootId?: string;
    entry?: string;
    threadRoot?: string;
    file?: string;
  }>();
  const id = firstRouteParam(params.id);
  const rootId = firstRouteParam(params.rootId);
  if (!id || !rootId) return <Redirect href="/" />;
  return (
    <Redirect
      href={
        {
          pathname: '/thread/[rootId]',
          params: { rootId, channelId: id, ...inboundQueryParams(params) },
        } as Href
      }
    />
  );
}

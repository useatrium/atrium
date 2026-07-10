import { Redirect, useLocalSearchParams, type Href } from 'expo-router';
import { firstRouteParam, inboundQueryParams } from '../../../../src/lib/deepLinkRoutes';

export default function ChannelAliasRoute() {
  const params = useLocalSearchParams<{ id?: string; entry?: string; threadRoot?: string; file?: string }>();
  const id = firstRouteParam(params.id);
  if (!id) return <Redirect href="/" />;
  return (
    <Redirect
      href={
        {
          pathname: '/channel/[id]',
          params: { id, ...inboundQueryParams(params) },
        } as Href
      }
    />
  );
}

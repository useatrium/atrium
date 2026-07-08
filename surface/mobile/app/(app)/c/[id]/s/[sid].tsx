import { Redirect, useLocalSearchParams, type Href } from 'expo-router';
import { firstRouteParam, inboundQueryParams } from '../../../../../src/lib/deepLinkRoutes';

export default function ChannelSessionAliasRoute() {
  const params = useLocalSearchParams<{
    id?: string;
    sid?: string;
    entry?: string;
    threadRoot?: string;
    file?: string;
  }>();
  const sid = firstRouteParam(params.sid);
  if (!sid) return <Redirect href="/" />;
  return (
    <Redirect
      href={
        {
          pathname: '/session/[id]',
          params: { id: sid, ...inboundQueryParams(params) },
        } as Href
      }
    />
  );
}

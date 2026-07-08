import { Redirect, useLocalSearchParams, type Href } from 'expo-router';
import { firstRouteParam, inboundQueryParams } from '../../../src/lib/deepLinkRoutes';

export default function SessionAliasRoute() {
  const params = useLocalSearchParams<{ id?: string; entry?: string; threadRoot?: string; file?: string }>();
  const id = firstRouteParam(params.id);
  if (!id) return <Redirect href="/" />;
  return (
    <Redirect
      href={
        {
          pathname: '/session/[id]',
          params: { id, ...inboundQueryParams(params) },
        } as Href
      }
    />
  );
}

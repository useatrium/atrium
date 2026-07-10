import { Redirect, useLocalSearchParams, type Href } from 'expo-router';
import { inboundQueryParams } from '../../../src/lib/deepLinkRoutes';

export default function SettingsSectionAliasRoute() {
  const params = useLocalSearchParams<{ entry?: string; threadRoot?: string; file?: string }>();
  return (
    <Redirect
      href={
        {
          pathname: '/settings',
          params: inboundQueryParams(params),
        } as Href
      }
    />
  );
}

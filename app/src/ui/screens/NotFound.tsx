import { Compass } from 'lucide-react';
import { navigate } from '@/state/router';
import { Button, EmptyState } from '../components';
import { Page } from '../layout/Page';
import type { ScreenProps } from '.';

export default function NotFound(_: ScreenProps) {
  return (
    <Page>
      <EmptyState
        icon={Compass}
        title="Nothing on this frequency"
        description="This page does not exist."
        actions={
          <Button variant="primary" onClick={() => navigate('/', { replace: true })}>
            Go home
          </Button>
        }
      />
    </Page>
  );
}

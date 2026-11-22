import { handle } from '@/lib/api';
import { governance } from '@/lib/data';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => governance());

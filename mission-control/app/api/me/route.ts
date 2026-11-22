import { asUser, handle, identity } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const [r] = await asUser(`SELECT CURRENT_USER() AS user_name, IS_ROLE_IN_SESSION('MLOPS_APPROVER') AS approver`);
  return { user: r?.user_name ?? null, approver: Boolean(r?.approver), identity: identity() };
});

/**
 * 路由表定义
 *
 * 使用 react-router 的 createBrowserRouter / RouterProvider。
 * ConsoleLayout 作为父路由，各页面作为子路由。
 */
import { createHashRouter, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { WorkbenchPage } from '@/pages/workbench/WorkbenchPage';
import { WikiPage } from '@/pages/wiki/WikiPage';
import { NotesPage } from '@/pages/notes/NotesPage';
import { CodePage } from '@/pages/code/CodePage';
import { SkillsPage } from '@/pages/skills/SkillsPage';
import { MemoryPage } from '@/pages/memory/MemoryPage';
import { MembersPage } from '@/pages/team/MembersPage';
import { AgentsPage } from '@/pages/team/AgentsPage';
import { ApiKeysPage } from '@/pages/team/ApiKeysPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      { index: true, element: <WorkbenchPage /> },
        { path: 'notes', element: <NotesPage /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'code', element: <CodePage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'team/members', element: <MembersPage /> },
      { path: 'team/agents', element: <AgentsPage /> },
      { path: 'team/api-keys', element: <ApiKeysPage /> },
    ],
  },
];

/**
 * 使用 HashRouter — 保持与旧版 hash 路由兼容，
 * 避免刷新 404（静态部署不需要服务端 fallback 配置）。
 */
export const router = createHashRouter(routes);

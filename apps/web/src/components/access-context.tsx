'use client';
import { createContext, useContext } from 'react';

export type WorkspaceRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF' | 'VIEWER';
const RoleContext = createContext<WorkspaceRole>('VIEWER');
export const RoleProvider = RoleContext.Provider;
export function useWorkspaceRole() { return useContext(RoleContext); }

import { createContext, useContext } from 'react';
import type { CurrentUser } from './api';

// Текущий пользователь и его роль. Заполняется в PrivateLayout ответом /auth/me,
// поэтому внутри защищённых страниц он всегда определён.
//
// Важно: это ТОЛЬКО для отрисовки — прятать пункт меню не значит закрыть доступ.
// Реальная граница прав на бэкенде (requireAdmin + проверки владельца).
export const AuthContext = createContext<CurrentUser | null>(null);

export function useCurrentUser(): CurrentUser {
  const user = useContext(AuthContext);
  if (!user) throw new Error('useCurrentUser вызван вне PrivateLayout');
  return user;
}

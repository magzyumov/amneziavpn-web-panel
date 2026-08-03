// Ошибка, текст которой предназначен пользователю панели.
//
// Глобальный обработчик (index.ts) по умолчанию отдаёт обезличенное
// "Internal server error", чтобы наружу не утекали детали реализации. Но большая
// часть ошибок здесь — не сбои, а внятные причины отказа («порт занят
// контейнером X», «контейнер не запущен», «S1-S4 должны быть >= 12»), и
// пользователю нужен именно их текст: панель админская, а без него единственный
// способ понять причину — лезть в docker logs.
//
// UserError помечает такие случаи. Всё, что брошено обычным Error, по-прежнему
// показывается как "Internal server error".
export class UserError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export function isUserError(err: unknown): err is UserError {
  return err instanceof UserError;
}

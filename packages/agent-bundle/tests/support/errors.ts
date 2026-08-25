/** Builds the errno-shaped failures durability tests inject through storage seams. */
export const errnoFailure = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

/** Row shape of `SELECT id, username, email, role FROM users`. */
export interface UserProfileRow {
    id: string;
    username: string;
    email: string;
    role: string;
}

/** A user profile row plus the stored bcrypt hash, used only at login. */
export interface UserCredentialsRow extends UserProfileRow {
    password_hash: string;
}

import { pool } from './db_pool';
export async function listOrders(req, res) {
  const client = await pool.connect();
  const rows = await pool.query('select * from orders');
  res.json(rows);            // never releases the client
}

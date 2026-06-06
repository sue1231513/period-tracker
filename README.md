# Period Tracker MCP

经期 & 排卵期记录工具 - 帮老婆记录和预测经期、追踪排卵期

## 工具

### 经期
- `add_period` - 记录一次经期
- `list_periods` - 查看历史记录
- `delete_period` - 删除一条记录

### 排卵期
- `add_ovulation` - 记录一次排卵期
- `list_ovulations` - 查看排卵期历史
- `delete_ovulation` - 删除一条排卵期记录

### 状态
- `get_cycle_status` - 查看当前周期阶段（经期/卵泡期/排卵期/黄体期）和预测下一次

## 部署

需要设置环境变量:
- `SUPABASE_URL`
- `SUPABASE_KEY`

需要在Supabase创建表 `period_records`:
```sql
create table period_records (
  id serial primary key,
  start_date date not null,
  notes text default ''
);
```

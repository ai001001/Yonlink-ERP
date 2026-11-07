'use strict';
/**
 * 业务交接页面（参照亿星“业务交接”）：员工离职或调岗时，把客户、跟单和单据一键转交
 * Business handover page (modelled on 亿星): transfer customers, merchandising and documents in one step.
 */
(() => {
  const { esc, get, post, toast, tableHtml, can, route, setTitle, confirmBox, optHtml, clearOptions } = ERP;

  route(/^\/handover$/, async (_, main) => {
    setTitle('业务交接');
    const [emps, history] = await Promise.all([ERP.options('employee', true), get('/api/handovers')]);
    const editable = can('system', 'edit');
    main.innerHTML = `<div class="panel">
        <div class="panel-head"><h3>业务交接：员工离职或调岗时一键转交</h3></div>
        <div class="alert info"><span>选择交出人后会列出他名下的客户和单据数量。勾选要转交的内容和接收人，确认后一次性转交，并留下交接记录。
          业务员只能看到自己名下的客户和单据，所以建议连同历史单据一起交接，接手人才能看到以往报价、订单。</span></div>
        <div class="form-grid">
          <label><span class="req">交出人</span><select id="hoFrom">${optHtml(emps, '')}</select></label>
          <label><span class="req">接收人</span><select id="hoTo">${optHtml(emps, '')}</select></label>
          <label><span>交接原因</span><input id="hoReason" placeholder="例如：离职 / 调岗 / 客户重新分配"></label>
        </div>
        <div id="hoScopes" style="margin-top:12px"></div>
      </div>
      <div class="panel"><div class="panel-head"><h3>交接记录</h3></div>
        ${tableHtml(['时间', '交出人', '接收人', '范围', '转交数量', '原因', '操作人'], history.map((h) => [esc(h.created_at), esc(h.from_name), esc(h.to_name),
    h.history ? '含历史单据' : '仅未完结单据', esc(h.detail) + (h.mark_left ? '；交出人已设为离职' : ''), esc(h.reason), esc(h.user_name)]))}</div>`;
    const $ = (s) => main.querySelector(s);

    /** 加载交出人名下数量 / load counts for the selected employee */
    const load = async () => {
      const from = $('#hoFrom').value;
      if (!from) { $('#hoScopes').innerHTML = ''; return; }
      const { scopes } = await get('/api/handover/preview?from=' + from);
      $('#hoScopes').innerHTML = `${tableHtml(['转交', '内容', '全部', '其中未完结', '说明'], scopes.map((s) => [
        `<input type="checkbox" data-scope="${s.key}" ${s.all && s.key !== 'samples' ? 'checked' : ''} ${s.all ? '' : 'disabled'}>`, esc(s.label), s.all, s.has_open ? s.open : '-', esc(s.note)]), new Set([2, 3]))}
        <div class="toolbar" style="margin-top:10px">
          <label class="inline"><input type="radio" name="hoHist" value="1" checked> 含历史单据（推荐）</label>
          <label class="inline"><input type="radio" name="hoHist" value="0"> 只交接未完结单据</label>
          <label class="inline"><input type="checkbox" id="hoLeft"> 同时把交出人设为“离职”</label>
          ${editable ? '<button class="btn primary" type="button" id="hoGo">确认交接</button>' : '<span class="muted small">需要系统权限管理的“修改”权限</span>'}
        </div>`;
      const go = $('#hoGo');
      if (go) {
        go.onclick = async () => {
          const scopes = [...main.querySelectorAll('[data-scope]')].filter((c) => c.checked).map((c) => c.dataset.scope);
          const to = $('#hoTo').value;
          const fromName = $('#hoFrom').selectedOptions[0].textContent;
          const toName = to ? $('#hoTo').selectedOptions[0].textContent : '';
          if (!to) { toast('请选择接收人', 'error'); return; }
          if (!(await confirmBox(`确定把「${fromName}」名下选中的内容转交给「${toName}」？`))) return;
          go.disabled = true;
          try {
            const r = await post('/api/handover', {
              from_emp_id: Number($('#hoFrom').value), to_emp_id: Number(to), scopes, reason: $('#hoReason').value,
              include_history: main.querySelector('[name="hoHist"]:checked').value === '1', mark_left: $('#hoLeft').checked,
            });
            toast(`交接完成：${Object.entries(r.counts).map(([k, n]) => `${r.labels[k]}${n}`).join('、')}`, 'ok');
            clearOptions();
            ERP.navigate();
          } catch (e) { toast(e.message, 'error'); go.disabled = false; }
        };
      }
    };
    $('#hoFrom').onchange = () => load().catch((e) => toast(e.message, 'error'));
  });
})();

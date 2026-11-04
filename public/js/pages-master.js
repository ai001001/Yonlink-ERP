'use strict';
/**
 * 基础档案页面：通用档案列表、客户/样品详情、系统管理
 * Master-data pages: generic entity lists, customer/sample detail, system administration.
 */
(() => {
  const { esc, money, get, post, put, del, toast, modal, formHtml, readForm, tableHtml, tag, can, route, setTitle, exportTable, printHtml, confirmBox, clearOptions } = ERP;

  /**
   * 单元格显示值 / Cell display value for an entity field.
   * @param {object} f 字段 / field
   * @param {object} row 行 / row
   * @param {string} key 实体键 / entity key
   * @returns {string}
   */
  function cell(f, row, key) {
    const v = row[f.name];
    if (f.type === 'ref') return esc(row[f.name + '_label'] ?? '');
    if (f.name === 'status' || f.name === 'progress') return tag(v);
    if (key === 'sample' && f.name === 'company_no') return `<a href="#/sample/${row.id}">${esc(v)}</a>`;
    if (key === 'customer' && f.name === 'name') return `<a href="#/customer/${row.id}">${esc(v)}</a>`;
    if (f.type === 'textarea') return `<span title="${esc(v)}">${esc(String(v ?? '').slice(0, 40))}${String(v ?? '').length > 40 ? '…' : ''}</span>`;
    return esc(v);
  }

  /**
   * 通用档案列表页 / Generic entity list page.
   * @param {string} key 实体键 / entity key
   * @param {HTMLElement} main
   * @param {URLSearchParams} qs
   */
  async function entityPage(key, main, qs) {
    const ent = ERP.state.meta.entities[key];
    if (!ent) throw new Error('无权访问该页面或模块已停用');
    setTitle(ent.title);
    const cols = ent.fields.filter((f) => f.list);
    const page = Number(qs.get('page') || 1);
    const q = qs.get('q') || '';
    const extra = [...qs.entries()].filter(([k]) => k.startsWith('f_')).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
    const data = await get(`/api/e/${key}?page=${page}&size=50&q=${encodeURIComponent(q)}${extra}`);
    const canAdd = !ent.readonly && can(ent.module, 'add');
    const canEdit = !ent.readonly && can(ent.module, 'edit');
    const canDel = !ent.readonly && can(ent.module, 'delete');
    const headers = [...cols.map((f) => f.label), ...(key === 'inventory' ? ['库存预警'] : []), ...(canEdit || canDel ? ['操作'] : [])];
    const rows = data.rows.map((r) => [
      ...cols.map((f) => cell(f, r, key)),
      ...(key === 'inventory' ? [tag(r.alert)] : []),
      ...(canEdit || canDel ? [`${canEdit ? `<button class="btn small" data-edit="${esc(r.id)}">编辑</button> ` : ''}${canDel ? `<button class="btn small danger" data-del="${esc(r.id)}">删除</button>` : ''}`] : []),
    ]);
    const pages = Math.max(1, Math.ceil(data.total / 50));
    main.innerHTML = `<div class="panel">
      <div class="panel-head"><h2>${esc(ent.title)} <span class="muted small">共 ${data.total} 条</span></h2>
        <div class="toolbar">
          <input class="search" id="q" placeholder="搜索关键字，回车查询" value="${esc(q)}">
          ${canAdd ? '<button class="btn primary" id="add">＋ 新增</button>' : ''}
          ${can(ent.module, 'export') ? '<button class="btn" id="exp">导出Excel</button>' : ''}
          ${can(ent.module, 'print') ? '<button class="btn" id="prt">打印</button>' : ''}
          ${key === 'currency' && can('trade', 'edit') ? '<button class="btn primary" id="autoRate">⟳ 自动更新汇率</button>' : ''}
        </div></div>
      ${key === 'currency' ? '<div class="alert info" id="rateStatus">汇率来源加载中…</div>' : ''}
      ${ent.readonly ? '<div class="alert info">此台账由系统根据业务自动生成，只读。</div>' : ''}
      ${tableHtml(headers, rows)}
      <div class="pager"><span>第 ${page}/${pages} 页</span>
        <button class="btn small" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">上一页</button>
        <button class="btn small" ${page >= pages ? 'disabled' : ''} data-page="${page + 1}">下一页</button></div></div>`;
    const go = (p, qq) => { location.hash = `#/e/${key}?page=${p}&q=${encodeURIComponent(qq ?? q)}${extra}`; };
    if (key === 'currency') {
      get('/api/rates/status').then((st) => {
        const el = main.querySelector('#rateStatus');
        if (el) el.textContent = `最近自动更新：${st.last || '尚未更新'}　来源：${st.source || st.api}　自动更新周期：${Number(st.hours) ? `每${st.hours}小时` : '已关闭'}　单次波动超过${st.max_change}%不自动采用（可在 系统权限管理→系统参数 中修改）`;
      }).catch(() => {});
      const ar = main.querySelector('#autoRate');
      if (ar) {
        ar.onclick = async () => {
          ar.disabled = true;
          try {
            const r = await post('/api/rates/update');
            modal({
              title: '汇率更新结果', body: `<p class="small muted">来源：${esc(r.source)}　数据时间：${esc(r.date)}</p>
                ${r.updated.length || r.skipped.length ? tableHtml(['币种', '原汇率', '新汇率', '结果'], [...r.updated.map((x) => [esc(x.code), x.old, x.new, tag('已更新')]), ...r.skipped.map((x) => [esc(x.code), x.old ?? '', x.new ?? '', `<span class="tag warn">${esc(x.reason)}</span>`])]) : '<div class="alert info">汇率已是最新，无需更新。</div>'}
                ${r.unchanged ? `<p class="small muted">${r.unchanged} 个币种汇率无变化</p>` : ''}`,
            });
            ERP.clearOptions();
            ERP.navigate();
          } catch (e) { toast(e.message, 'error'); ar.disabled = false; }
        };
      }
    }
    main.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go(1, e.target.value.trim()); };
    main.querySelectorAll('[data-page]').forEach((b) => { b.onclick = () => go(b.dataset.page); });
    const plain = data.rows.map((r) => cols.map((f) => (f.type === 'ref' ? r[f.name + '_label'] ?? '' : r[f.name] ?? '')));
    const expBtn = main.querySelector('#exp');
    if (expBtn) expBtn.onclick = () => exportTable(ent.module, ent.title, cols.map((f) => f.label), plain);
    const prtBtn = main.querySelector('#prt');
    if (prtBtn) prtBtn.onclick = () => printHtml(`<h1>${esc(ent.title)}</h1><div class="sub">打印时间：${new Date().toLocaleString()}</div>${tableHtml(cols.map((f) => f.label), plain.map((r) => r.map(esc)))}`);
    const open = async (row) => {
      const m = modal({
        title: (row ? '编辑' : '新增') + ent.title, wide: ent.fields.length > 8, body: await formHtml(ent.fields, row || {}),
        buttons: [{
          text: '保存', cls: 'primary', onClick: async (mm) => {
            const body = readForm(mm.el);
            if (row) await put(`/api/e/${key}/${encodeURIComponent(row.id)}`, body); else await post(`/api/e/${key}`, body);
            mm.close();
            clearOptions();
            toast('保存成功', 'ok');
            ERP.navigate();
          },
        }],
      });
      return m;
    };
    const addBtn = main.querySelector('#add');
    if (addBtn) addBtn.onclick = () => open(null);
    main.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = async () => open(await get(`/api/e/${key}/${encodeURIComponent(b.dataset.edit)}`));
    });
    main.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmBox('确定删除该记录吗？删除后不可恢复。'))) return;
        try { await del(`/api/e/${key}/${encodeURIComponent(b.dataset.del)}`); toast('已删除', 'ok'); clearOptions(); ERP.navigate(); } catch (e) { toast(e.message, 'error'); }
      };
    });
  }
  route(/^\/e\/(\w+)$/, ([key], main, qs) => entityPage(key, main, qs));

  // ---------- 客户 360 / customer overview ----------
  route(/^\/customer\/(\d+)$/, async ([id], main) => {
    const d = await get(`/api/customers/${id}/overview`);
    setTitle('客户档案：' + d.customer.name);
    const c = d.customer;
    const sec = (title, headers, rows) => `<div class="panel"><h3 class="section-title">${title} <span class="muted small">${rows.length} 条</span></h3>${tableHtml(headers, rows)}</div>`;
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(c.name)} ${tag(c.level)}</h2>
        <div class="toolbar">${can('customer', 'add') ? '<button class="btn primary" id="follow">＋ 跟进记录</button>' : ''}<a class="btn" href="#/e/customer">返回列表</a></div></div>
      <div class="kv"><div><b>编码</b><span>${esc(c.code)}</span></div><div><b>国别</b><span>${esc(c.country)}</span></div><div><b>联系人</b><span>${esc(c.contact)}</span></div>
      <div><b>邮箱</b><span>${esc(c.email)}</span></div><div><b>业务员</b><span>${esc(c.salesman_name)}</span></div><div><b>来源</b><span>${esc(c.source)}</span></div></div></div>
      ${sec('跟进日志 / 询盘记录', ['时间', '类型', '内容', '下次跟进', '记录人'], d.follows.map((x) => [esc(x.created_at), esc(x.type), esc(x.content), esc(x.next_date), esc(x.user_name)]))}
      ${sec('往来邮件', ['时间', '方向', '主题', '分类'], d.mails.map((x) => [esc(x.created_at), esc(x.direction), esc(x.subject), esc(x.category)]))}
      ${sec('历史报价', ['报价单号', '日期', '金额', '状态'], d.quotes.map((x) => [`<a href="#/quote/${x.id}">${esc(x.quote_no)}</a>`, esc(String(x.created_at).slice(0, 10)), `${money(x.amount)} ${esc(x.currency)}`, tag(x.status)]))}
      ${sec('历史送样', ['送样单号', '货号', '快递单号', '状态'], d.sends.map((x) => [`<a href="#/send/${x.id}">${esc(x.send_no)}</a>`, esc(x.item_nos), esc(x.tracking_no), tag(x.status)]))}
      ${sec('历史订单', ['订单号', '下单日期', '金额', '状态'], d.orders.map((x) => [`<a href="#/order/${x.id}">${esc(x.order_no)}</a>`, esc(x.order_date), `${money(x.amount)} ${esc(x.currency)}`, tag(x.status)]))}
      ${sec('回款记录', ['日期', '订单', '类型', '金额', '折人民币'], d.receipts.map((x) => [esc(x.receipt_date), esc(x.order_no), esc(x.type), `${money(x.amount)} ${esc(x.currency)}`, money(x.amount_cny)]))}`;
    const fb = main.querySelector('#follow');
    if (fb) {
      fb.onclick = async () => modal({
        title: '新增跟进记录', body: await formHtml(ERP.state.meta.entities.customer_follow.fields.filter((f) => f.name !== 'customer_id'), {}),
        buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/e/customer_follow', { ...readForm(m.el), customer_id: id }); m.close(); toast('已记录', 'ok'); ERP.navigate(); } }],
      });
    }
  });

  // ---------- 样品详情 / sample detail ----------
  route(/^\/sample\/(\d+)$/, async ([id], main) => {
    const d = await get(`/api/samples/${id}/overview`);
    const s = d.sample;
    setTitle('样品档案：' + s.company_no);
    const imgs = String(s.images || '').split(/[,，\s]+/).filter(Boolean);
    const sec = (title, headers, rows) => `<div class="panel"><h3 class="section-title">${title} <span class="muted small">${rows.length} 条</span></h3>${tableHtml(headers, rows)}</div>`;
    const cost = (Number(s.material_cost) || 0) + (Number(s.labor_cost) || 0);
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>${esc(s.company_no)} ${esc(s.name)} ${tag(s.status)} ${tag(s.progress)}</h2>
        <div class="toolbar">${can('sample', 'add') ? '<button class="btn" id="rev">＋ 改样日志</button>' : ''}<a class="btn" href="#/e/sample">返回列表</a></div></div>
      ${s.status === '已锁定' ? `<div class="lock-banner">该旧货号已被新货号 ${d.children.map((c) => `<a href="#/sample/${c.id}">${esc(c.company_no)}</a>`).join('、')} 替代并锁定，禁止报价/下单/出货。</div>` : ''}
      <div class="kv">
        <div><b>公司货号</b><span>${esc(s.company_no)}</span></div><div><b>客户货号</b><span>${esc(s.customer_no)}</span></div><div><b>工厂货号</b><span>${esc(s.factory_no)}</span></div>
        <div><b>英文品名</b><span>${esc(s.name_en)}</span></div><div><b>尺寸(cm)</b><span>${s.length_cm ? `${s.length_cm}×${s.width_cm}×${s.height_cm}` : ''}</span></div>
        <div><b>材质</b><span>${esc(s.material)}</span></div><div><b>工艺</b><span>${esc(s.craft)}</span></div><div><b>花色</b><span>${esc(s.color)}</span></div>
        <div><b>耗材</b><span>${esc(s.consumables)}</span></div><div><b>设计师</b><span>${esc(s.designer_name)}</span></div><div><b>生产工厂</b><span>${esc(s.supplier_name)}</span></div>
        <div><b>材料+人工成本</b><span>¥${money(cost)}</span></div><div><b>打样费用</b><span>¥${money(s.sample_fee)}</span></div><div><b>样品库存</b><span>${esc(s.stock_qty)}</span></div>
        <div><b>包装要求</b><span>${esc(s.package_req)}</span></div><div><b>标签规范</b><span>${esc(s.label_req)}</span></div><div><b>内盒</b><span>${esc(s.inner_box)}</span></div>
        <div><b>外箱(cm)</b><span>${s.outer_l ? `${s.outer_l}×${s.outer_w}×${s.outer_h}，${s.pcs_per_carton}只/箱` : ''}</span></div><div><b>MOQ</b><span>${esc(s.moq)}</span></div>
        <div><b>原货号</b><span>${s.parent_no ? esc(s.parent_no) : '-'}</span></div>
      </div>
      <div class="panel-head" style="margin:14px 0 6px"><h3>样品图片 <span class="muted small">${imgs.length} 张</span></h3>
        ${can('sample', 'edit') ? '<label class="btn small">＋ 上传图片<input type="file" id="upl" accept="image/*" multiple hidden></label>' : ''}</div>
      <div class="gallery">${imgs.length ? imgs.map((u) => `<figure><img data-ref="${esc(u)}" alt="样品图片" loading="lazy">
        ${can('sample', 'edit') && u.startsWith('file:') ? `<button class="btn small danger" data-delimg="${esc(u.slice(5))}" title="删除">✕</button>` : ''}</figure>`).join('') : '<div class="muted small">暂无图片（可上传多角度样品照片，自动压缩）</div>'}</div></div>
      ${sec('改样日志', ['时间', '阶段', '内容', '记录人'], d.revisions.map((x) => [esc(x.created_at), tag(x.stage), esc(x.content), esc(x.user_name)]))}
      ${d.quotes ? sec('报价记录', ['报价单号', '客户', '数量', '单价', '新货号', '状态'], d.quotes.map((x) => [`<a href="#/quote/${x.quote_id}">${esc(x.quote_no)}</a>`, esc(x.customer_name), esc(x.qty), `${money(x.price)} ${esc(x.currency)}`, esc(x.new_item_no), tag(x.status)])) : ''}
      ${d.sends ? sec('送样记录', ['送样单号', '客户', '数量', '新货号', '状态'], d.sends.map((x) => [`<a href="#/send/${x.send_id}">${esc(x.send_no)}</a>`, esc(x.customer_name), esc(x.qty), esc(x.new_item_no), tag(x.status)])) : ''}
      ${d.orders ? sec('订单记录', ['订单号', '客户', '数量', '单价', '状态'], d.orders.map((x) => [`<a href="#/order/${x.order_id}">${esc(x.order_no)}</a>`, esc(x.customer_name), esc(x.qty), `${money(x.unit_price)} ${esc(x.currency)}`, tag(x.status)])) : ''}
      <div class="panel"><h3 class="section-title">送样转化率</h3><div class="kv"><div><b>送样次数</b><span>${d.stats.sends}</span></div><div><b>成交订单数</b><span>${d.stats.orders}</span></div><div><b>转化率</b><span>${d.stats.rate}</span></div></div></div>`;
    ERP.loadImages(main);
    main.querySelectorAll('.gallery img').forEach((im) => {
      im.onclick = () => modal({ title: `${s.company_no} 样品图片`, wide: true, body: `<img src="${im.src}" alt="样品图片" style="max-width:100%;display:block;margin:auto">` });
    });
    const upl = main.querySelector('#upl');
    if (upl) {
      upl.onchange = async () => {
        let n = 0;
        for (const f of upl.files) {
          try {
            await post(`/api/samples/${id}/images`, { name: f.name, data: await ERP.compressImage(f) });
            n++;
          } catch (e) { toast(`${f.name}：${e.message}`, 'error'); }
        }
        if (n) toast(`已上传 ${n} 张图片`, 'ok');
        ERP.navigate();
      };
    }
    main.querySelectorAll('[data-delimg]').forEach((b) => {
      b.onclick = async () => { if (await confirmBox('删除这张图片？')) { await del(`/api/samples/${id}/images/${b.dataset.delimg}`); toast('已删除', 'ok'); ERP.navigate(); } };
    });
    const rb = main.querySelector('#rev');
    if (rb) {
      rb.onclick = async () => modal({
        title: '新增改样日志', body: await formHtml(ERP.state.meta.entities.sample_revision.fields.filter((f) => f.name !== 'sample_id'), {}),
        buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/e/sample_revision', { ...readForm(m.el), sample_id: id }); m.close(); toast('已记录', 'ok'); ERP.navigate(); } }],
      });
    }
  });

  // ---------- 系统管理 / system administration ----------
  route(/^\/system$/, async (_, main, qs) => {
    setTitle('系统权限管理');
    const tab = qs.get('tab') || 'modules';
    const tabs = [['modules', '模块启停'], ['roles', '岗位角色权限'], ['users', '账号管理'], ['settings', '系统参数'], ['logs', '登录/操作日志']];
    main.innerHTML = `<div class="panel"><div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="tabBody"></div></div>`;
    main.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = '#/system?tab=' + b.dataset.tab; }; });
    const body = main.querySelector('#tabBody');
    const editable = can('system', 'edit');
    if (tab === 'modules') {
      const mods = ERP.state.meta.modules;
      const stage = ['', '一期 基础档案', '二期 外贸获客', '三期 订单出货', '四期 财务收付', '五期 生产供应链', '六期 统计分析'];
      body.innerHTML = `<div class="alert info">松耦合可插拔：每个模块独立启停，停用后菜单隐藏、接口拒绝访问，数据保留，重新启用即可恢复。</div>
        ${tableHtml(['阶段', '模块', '状态', '启停'], mods.map((m) => [esc(stage[m.stage]), esc(m.name), tag(m.enabled ? '启用' : '禁用'),
          m.key === 'system' ? '<span class="muted small">核心模块</span>' : `<label class="switch"><input type="checkbox" data-mod="${m.key}" ${m.enabled ? 'checked' : ''} ${editable ? '' : 'disabled'}><span></span></label>`]))}`;
      body.querySelectorAll('[data-mod]').forEach((el) => {
        el.onchange = async () => {
          try { await put('/api/modules/' + el.dataset.mod, { enabled: el.checked }); toast(el.checked ? '模块已启用' : '模块已停用', 'ok'); await ERP.reloadMeta(); ERP.navigate(); } catch (e) { toast(e.message, 'error'); el.checked = !el.checked; }
        };
      });
    }
    if (tab === 'roles') {
      const { rows, actions } = await get('/api/roles');
      const actName = { view: '查看', add: '新增', edit: '修改', delete: '删除', export: '导出', print: '打印', audit: '审核' };
      const scopeName = { all: '全部数据', own: '仅本人数据', designer: '设计师本人样品' };
      body.innerHTML = `<div class="toolbar" style="margin-bottom:10px">${can('system', 'add') ? '<button class="btn primary" id="addRole">＋ 新增角色</button>' : ''}</div>
        ${tableHtml(['角色', '代码', '数据范围', '账号数', '说明', '操作'], rows.map((r) => [esc(r.name), esc(r.code), esc(scopeName[r.data_scope]), r.user_count, esc(r.remark),
          `${editable ? `<button class="btn small" data-role="${r.id}">配置权限</button>` : ''} ${can('system', 'delete') ? `<button class="btn small danger" data-delrole="${r.id}">删除</button>` : ''}`]))}`;
      const openRole = (role) => {
        const perms = role ? JSON.parse(role.perms || '{}') : {};
        const mods = ERP.state.meta.modules;
        const m = modal({
          title: role ? `配置权限：${role.name}` : '新增角色', wide: true,
          body: `<div class="form-grid"><label><span class="req">角色代码</span><input name="code" value="${esc(role?.code)}"></label><label><span class="req">角色名称</span><input name="name" value="${esc(role?.name)}"></label>
            <label><span>数据范围</span><select name="data_scope">${ERP.optHtml(Object.entries(scopeName).map(([id, label]) => ({ id, label })), role?.data_scope || 'all', false)}</select></label>
            <label><span>说明</span><input name="remark" value="${esc(role?.remark)}"></label></div>
            <div class="table-wrap" style="margin-top:12px"><table class="perm-table"><thead><tr><th>模块</th>${actions.map((a) => `<th>${actName[a]}</th>`).join('')}<th>整行</th></tr></thead><tbody>
            ${mods.map((md) => `<tr><td>${esc(md.name)}</td>${actions.map((a) => `<td><input type="checkbox" data-p="${md.key}:${a}" ${(perms[md.key] || []).includes(a) ? 'checked' : ''}></td>`).join('')}<td><button class="btn small" data-row="${md.key}" type="button">全选</button></td></tr>`).join('')}
            </tbody></table></div>`,
          buttons: [{
            text: '保存', cls: 'primary', onClick: async (mm) => {
              const p = {};
              mm.el.querySelectorAll('[data-p]').forEach((c) => { if (c.checked) { const [k, a] = c.dataset.p.split(':'); (p[k] = p[k] || []).push(a); } });
              const f = {};
              mm.el.querySelectorAll('.form-grid [name]').forEach((el) => { f[el.name] = el.value; });
              if (role) await put('/api/roles/' + role.id, { ...f, perms: p }); else await post('/api/roles', { ...f, perms: p });
              mm.close(); toast('角色权限已保存', 'ok'); ERP.navigate();
            },
          }],
        });
        m.el.querySelectorAll('[data-row]').forEach((b) => { b.onclick = () => m.el.querySelectorAll(`[data-p^="${b.dataset.row}:"]`).forEach((c) => { c.checked = true; }); });
      };
      const ab = body.querySelector('#addRole');
      if (ab) ab.onclick = () => openRole(null);
      body.querySelectorAll('[data-role]').forEach((b) => { b.onclick = () => openRole(rows.find((x) => x.id === Number(b.dataset.role))); });
      body.querySelectorAll('[data-delrole]').forEach((b) => { b.onclick = async () => { if (await confirmBox('确定删除该角色？')) { try { await del('/api/roles/' + b.dataset.delrole); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } } }; });
    }
    if (tab === 'users') {
      const [{ rows }, roles, emps] = await Promise.all([get('/api/users'), ERP.options('role', true), ERP.options('employee', true)]);
      body.innerHTML = `<div class="toolbar" style="margin-bottom:10px">${can('system', 'add') ? '<button class="btn primary" id="addUser">＋ 新增账号</button>' : ''}
        ${editable ? `<span class="muted small">批量授权：勾选账号后选择角色</span><select id="batchRole" style="width:160px">${ERP.optHtml(roles, '')}</select><button class="btn" id="batchBtn">批量授权</button>` : ''}</div>
        ${tableHtml(['', '账号', '姓名', '角色', '绑定员工', '状态', '创建时间', '操作'], rows.map((u) => [`<input type="checkbox" data-uid="${u.id}">`, esc(u.username), esc(u.name), esc(u.role_name), esc(u.employee_name), tag(u.status), esc(u.created_at),
          editable ? `<button class="btn small" data-eu="${u.id}">编辑</button> <button class="btn small" data-rp="${u.id}">重置密码</button> <button class="btn small ${u.status === '启用' ? 'danger' : ''}" data-tg="${u.id}">${u.status === '启用' ? '禁用' : '启用'}</button>` : '']))}`;
      const userForm = (u) => `<div class="form-grid"><label><span class="req">账号</span><input name="username" value="${esc(u?.username)}" ${u ? 'disabled' : ''}></label>
        <label><span class="req">姓名</span><input name="name" value="${esc(u?.name)}"></label>
        <label><span class="req">角色</span><select name="role_id">${ERP.optHtml(roles, u?.role_id)}</select></label>
        <label><span>绑定员工（设计师/业务员必须绑定）</span><select name="employee_id">${ERP.optHtml(emps, u?.employee_id)}</select></label>
        ${u ? '' : '<label><span>初始密码（默认123456）</span><input name="password" type="password"></label>'}</div>`;
      const au = body.querySelector('#addUser');
      if (au) au.onclick = () => modal({ title: '新增账号', body: userForm(null), buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/users', readForm(m.el)); m.close(); toast('账号已创建', 'ok'); ERP.navigate(); } }] });
      body.querySelectorAll('[data-eu]').forEach((b) => {
        const u = rows.find((x) => x.id === Number(b.dataset.eu));
        b.onclick = () => modal({ title: '编辑账号', body: userForm(u), buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await put('/api/users/' + u.id, readForm(m.el)); m.close(); toast('已保存', 'ok'); ERP.navigate(); } }] });
      });
      body.querySelectorAll('[data-rp]').forEach((b) => { b.onclick = async () => { if (await confirmBox('将密码重置为 123456？')) { await post(`/api/users/${b.dataset.rp}/reset-password`, {}); toast('密码已重置为123456', 'ok'); } }; });
      body.querySelectorAll('[data-tg]').forEach((b) => {
        const u = rows.find((x) => x.id === Number(b.dataset.tg));
        b.onclick = async () => { try { await put('/api/users/' + u.id, { status: u.status === '启用' ? '禁用' : '启用' }); ERP.navigate(); } catch (e) { toast(e.message, 'error'); } };
      });
      const bb = body.querySelector('#batchBtn');
      if (bb) {
        bb.onclick = async () => {
          const ids = [...body.querySelectorAll('[data-uid]:checked')].map((c) => Number(c.dataset.uid));
          try { const r = await post('/api/users/batch-role', { ids, role_id: body.querySelector('#batchRole').value }); toast(`已为${r.count}个账号授权`, 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); }
        };
      }
    }
    if (tab === 'settings') {
      const s = await get('/api/settings');
      body.innerHTML = `<div class="form-grid"><label><span>公司中文名</span><input name="company_name" value="${esc(s.company_name)}"></label>
        <label><span>公司英文名</span><input name="company_name_en" value="${esc(s.company_name_en)}"></label>
        <label><span>报价最低利润率%（低于则审批预警）</span><input name="quote_min_profit" type="number" value="${esc(s.quote_min_profit)}"></label>
        <label class="wide"><span>汇率接口地址（失败时自动切换备用接口）</span><input name="rate_api_url" value="${esc(s.rate_api_url)}"></label>
        <label><span>汇率自动更新周期（小时，0=关闭）</span><input name="rate_auto_hours" type="number" value="${esc(s.rate_auto_hours)}"></label>
        <label><span>汇率异常波动阈值%（超过不自动采用）</span><input name="rate_max_change" type="number" value="${esc(s.rate_max_change)}"></label>
        <label><span>自动收信间隔（分钟，0=关闭）</span><input name="mail_fetch_minutes" type="number" value="${esc(s.mail_fetch_minutes)}"></label>
        <label><span>新邮箱首次同步最近邮件数</span><input name="mail_initial_sync" type="number" value="${esc(s.mail_initial_sync)}"></label></div>
        ${editable ? '<div style="margin-top:12px"><button class="btn primary" id="saveSet">保存参数</button></div>' : ''}`;
      const sb = body.querySelector('#saveSet');
      if (sb) sb.onclick = async () => { await put('/api/settings', readForm(body)); toast('参数已保存', 'ok'); await ERP.reloadMeta(); };
    }
    if (tab === 'logs') {
      location.hash = '#/e/log';
    }
  });
})();

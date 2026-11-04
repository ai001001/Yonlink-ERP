'use strict';
/**
 * 模拟业务数据目录：员工、客户、供应商、服务机构、样品、物料
 * Simulated master data: staff, customers, suppliers, agencies, samples, materials.
 * 所有公司与邮箱均为虚构（.example 保留域名）/ All companies and addresses are fictitious (.example reserved TLD).
 * @module scripts/demo-catalog
 */

/** 新增员工 [工号, 姓名, 部门, 岗位, 账号, 角色] / Extra staff [no, name, dept, position, username, role] */
const STAFF = [
  ['E011', '陈静', '外贸业务部', '外贸业务员', 'sales3', 'sales'],
  ['E012', '黄敏', '外贸业务部', '跟单员', null, null],
  ['E013', '刘建国', '生产部', '质检员', null, null],
  ['E014', '何丽', '采购部', '采购员', null, null],
  ['E015', '马强', '生产部', '仓管员', null, null],
  ['E016', '苏雅', '设计部', '陶瓷设计师', 'designer3', 'designer'],
  ['E017', '冯晓', '财务部', '出纳', null, null],
];

/** 业务员 → 邮箱 / salesperson → mailbox */
const MAILBOX = { sales1: 'ai001@316191099.xyz', sales2: 'ai002@316191099.xyz', sales3: 'ai003@316191099.xyz' };

/** 客户 [编码, 名称, 国别, 联系人, 邮箱, 业务员账号, 等级, 来源, 币种, 目的港] / customers */
const CUSTOMERS = [
  ['C001', null, 'Germany', 'Hans Müller', 'hans@homedecor.de', 'sales1', 'A', '展会', 'EUR', 'Hamburg'],
  ['C002', null, 'USA', 'Emily Brown', 'emily@gardenliving.com', 'sales1', 'A', '阿里巴巴', 'USD', 'Los Angeles'],
  ['C003', null, 'France', 'Pierre Martin', 'pierre@maisonc.fr', 'sales2', 'B', '老客户介绍', 'EUR', 'Le Havre'],
  ['C004', 'Bloom & Co. Ltd', 'UK', 'Olivia Green', 'olivia@bloomandco.example', 'sales1', 'A', '展会', 'GBP', 'Felixstowe'],
  ['C005', 'Casa Bella S.r.l.', 'Italy', 'Giulia Rossi', 'giulia@casabella.example', 'sales1', 'B', '官网', 'EUR', 'Genoa'],
  ['C006', 'Nordic Living AB', 'Sweden', 'Erik Lindqvist', 'erik@nordicliving.example', 'sales1', 'A', '展会', 'EUR', 'Gothenburg'],
  ['C007', 'Maple Home Inc.', 'Canada', 'Sarah Thompson', 'sarah@maplehome.example', 'sales1', 'B', '阿里巴巴', 'USD', 'Vancouver'],
  ['C008', 'Sakura Zakka K.K.', 'Japan', 'Yuki Tanaka', 'tanaka@sakurazakka.example', 'sales1', 'B', '社媒', 'USD', 'Tokyo'],
  ['C009', 'Holland Flora B.V.', 'Netherlands', 'Daan de Vries', 'daan@hollandflora.example', 'sales2', 'A', '展会', 'EUR', 'Rotterdam'],
  ['C010', 'Sunshine Gifts Pty Ltd', 'Australia', 'Jack Wilson', 'jack@sunshinegifts.example', 'sales2', 'B', '阿里巴巴', 'USD', 'Sydney'],
  ['C011', 'Al Noor Trading LLC', 'UAE', 'Omar Haddad', 'omar@alnoortrading.example', 'sales2', 'C', '官网', 'USD', 'Jebel Ali'],
  ['C012', 'Iberia Deco S.L.', 'Spain', 'Lucía Fernández', 'lucia@iberiadeco.example', 'sales2', 'B', '展会', 'EUR', 'Valencia'],
  ['C013', 'Seoul Living Co.', 'Korea', 'Min-jun Park', 'minjun@seoulliving.example', 'sales2', 'C', '社媒', 'USD', 'Busan'],
  ['C014', 'Polska Dom Sp. z o.o.', 'Poland', 'Anna Kowalska', 'anna@polskadom.example', 'sales3', 'B', '阿里巴巴', 'EUR', 'Gdansk'],
  ['C015', 'Casa Brasil Ltda', 'Brazil', 'Rafael Souza', 'rafael@casabrasil.example', 'sales3', 'C', '官网', 'USD', 'Santos'],
  ['C016', 'Lakeside Retail Group', 'USA', 'Michael Carter', 'mcarter@lakesideretail.example', 'sales3', 'A', '展会', 'USD', 'New York'],
  ['C017', 'Atelier Wien GmbH', 'Austria', 'Sophie Huber', 'sophie@atelierwien.example', 'sales3', 'B', '老客户介绍', 'EUR', 'Hamburg'],
  ['C018', 'Kiwi Home Ltd', 'New Zealand', 'Liam Taylor', 'liam@kiwihome.example', 'sales3', 'C', '阿里巴巴', 'USD', 'Auckland'],
];

/** 新增供应商 [编码, 名称, 类型, 联系人, 电话, 结算, 品类, 评级, 邮箱] / extra suppliers */
const SUPPLIERS = [
  ['S006', '醴陵釉下彩瓷厂', '成品生产工厂', '谭厂长', '0731-23560006', '月结30天', '釉下彩餐具/茶叶罐', 'A', 'sales@liling-porcelain.example'],
  ['S007', '宜兴紫砂工艺厂', '成品生产工厂', '吴经理', '0510-87100007', '月结45天', '紫砂花盆/茶具/粗陶', 'B', 'order@yixing-craft.example'],
  ['S008', '德化永兴雕塑瓷厂', '成品生产工厂', '林师傅', '0595-23500008', '月结30天', '人物/动物/节日摆件', 'A', 'yx@dehua-sculpture.example'],
  ['S009', '潮州枫溪陶瓷原料厂', '原辅材料供应商', '陈老板', '0768-63000009', '月结30天', '高白泥/陶土', 'B', 'clay@fengxi-material.example'],
  ['S010', '佛山色釉料有限公司', '原辅材料供应商', '梁经理', '0757-82000010', '月结60天', '色釉/金水/青花料', 'A', 'glaze@foshan-glaze.example'],
  ['S011', '泉州恒印彩盒厂', '原辅材料供应商', '郑经理', '0595-22800011', '月结30天', '彩盒/内衬/吊牌', 'B', 'box@hengyin-pack.example'],
  ['S012', '义乌晶亮配件商行', '外购成品供应商', '金老板', '0579-85500012', '款到发货', 'LED灯串/金属托架', 'C', 'parts@jingliang.example'],
];

/** 新增服务机构 [名称, 类型, 联系人, 电话, 价格, 时效, 评价] / extra agencies */
const AGENCIES = [
  ['宁波港通国际物流', '货代公司', 'Kelly', '13900000006', '海运按柜报价，美线优势', 3, 'B'],
  ['厦门永诚国际货运', '货代公司', 'Leo', '13900000007', '欧线拼箱/整柜', 2, 'A'],
  ['厦门诚检验货服务', '验货机构', '周工', '13900000008', '1600元/人天', 1, 'B'],
  ['德化名匠雕塑工作室', '打样工厂', '许师傅', '13900000009', '雕塑打样 800-1500元/款', 7, 'A'],
  ['广州观澜产品设计', '产品设计机构', '黎设计', '13900000010', '整套系列设计 2万起', 15, 'B'],
];

/**
 * 新增样品 [货号, 品名, 英文, 长, 宽, 高, 材质, 工艺, 花色, 设计师工号, 工厂, 材料, 人工, 打样费, 外箱长, 宽, 高, 装箱数, MOQ]
 * Extra samples.
 */
const SAMPLES = [
  ['YL-V003', '青花缠枝莲纹大花瓶', 'Blue Lotus Scroll Vase', 22, 22, 45, '高白瓷', '手绘青花', '青花', 'E004', 'S001', 46, 30, 420, 60, 60, 52, 2, 200],
  ['YL-V004', '哑光北欧线条花瓶', 'Matte Nordic Ribbed Vase', 14, 14, 26, '陶瓷', '拉坯+压纹', '哑光白', 'E016', 'S001', 18, 9, 220, 46, 46, 30, 9, 600],
  ['YL-V005', '窑变花釉梅瓶', 'Flambé Glaze Meiping Vase', 16, 16, 30, '陶瓷', '窑变釉', '窑变红', 'E004', 'S006', 31, 18, 380, 52, 36, 36, 6, 300],
  ['YL-V006', '金线大理石纹花瓶', 'Gold-line Marble Vase', 12, 12, 24, '新骨瓷', '描金+贴花', '大理石纹', 'E005', 'S002', 24, 14, 260, 50, 38, 30, 12, 500],
  ['YL-V007', '宽口插花花器', 'Wide-mouth Ikebana Vessel', 22, 22, 12, '粗陶', '柴烧', '自然灰', 'E004', 'S007', 22, 14, 300, 50, 50, 30, 6, 300],
  ['YL-T002', '釉下彩手绘餐盘', 'Hand-painted Underglaze Plate', 27, 27, 3, '瓷', '釉下彩手绘', '蓝白', 'E005', 'S006', 12, 8, 160, 30, 30, 26, 12, 1000],
  ['YL-T003', '浮雕郁金香马克杯', 'Embossed Tulip Mug', 12, 9, 10, '炻瓷', '浮雕+色釉', '粉', 'E016', 'S002', 6.5, 3.5, 120, 52, 30, 22, 36, 2000],
  ['YL-T004', '冰裂釉茶具套装', 'Crackle Tea Set (6pcs)', 30, 22, 12, '陶瓷', '冰裂釉', '青灰', 'E004', 'S007', 38, 20, 350, 52, 34, 42, 4, 300],
  ['YL-T005', '撞色甜品碗', 'Two-tone Dessert Bowl', 14, 14, 7, '炻瓷', '双色釉', '奶白', 'E016', 'S006', 5.8, 2.6, 110, 46, 30, 30, 48, 3000],
  ['YL-D002', '招财猫陶瓷摆件', 'Lucky Cat Figurine', 13, 11, 18, '陶瓷', '彩绘+描金', '白金', 'E005', 'S008', 11, 9, 260, 50, 42, 40, 24, 600],
  ['YL-D003', '极简人物雕塑', 'Minimalist Figure Sculpture', 9, 7, 30, '素瓷', '手工雕塑', '哑光白', 'E004', 'S008', 15, 16, 480, 48, 34, 38, 12, 300],
  ['YL-D004', '圣诞雪人陶瓷灯', 'Snowman LED Ceramic Lamp', 12, 12, 20, '陶瓷', '彩绘+LED', '白红', 'E005', 'S008', 13, 7, 280, 52, 52, 46, 12, 1000],
  ['YL-D005', '圣诞球挂饰（6只装）', 'Christmas Ball Ornaments (6pcs)', 8, 8, 8, '瓷', '贴花+描金', '红金', 'E016', 'S002', 7, 3, 150, 40, 30, 30, 48, 2400],
  ['YL-D006', '复活节兔子摆件', 'Easter Bunny Figurine', 10, 8, 16, '陶瓷', '彩绘', '粉彩', 'E005', 'S008', 8, 6, 200, 46, 36, 34, 24, 1200],
  ['YL-D007', '观音坐像', 'Seated Guanyin Statue', 18, 14, 32, '德化白瓷', '手工雕塑', '象牙白', 'E004', 'S008', 58, 60, 900, 48, 40, 44, 4, 100],
  ['YL-D008', '小鹿摆件对装', 'Fawn Figurine Pair', 16, 7, 18, '陶瓷', '哑光釉', '奶咖', 'E016', 'S008', 12, 8, 220, 50, 40, 40, 12, 800],
  ['YL-P001', '紫砂多肉花盆', 'Yixing Succulent Planter', 10, 10, 8, '紫砂', '手工成型', '朱泥红', 'E004', 'S007', 9, 6, 150, 50, 30, 24, 36, 1000],
  ['YL-P002', '几何浮雕花盆带托盘', 'Geometric Relief Planter with Saucer', 16, 16, 15, '陶瓷', '浮雕+色釉', '鼠尾草绿', 'E016', 'S001', 14, 7, 200, 50, 50, 34, 12, 800],
  ['YL-P003', '大号户外花盆', 'Large Outdoor Planter', 35, 35, 32, '粗陶', '拉坯+喷釉', '炭灰', 'E005', 'S007', 42, 18, 300, 40, 40, 36, 1, 150],
  ['YL-C001', '镂空烛台', 'Openwork Candle Holder', 11, 11, 12, '陶瓷', '镂空雕刻', '象牙白', 'E004', 'S001', 9, 8, 210, 46, 46, 28, 24, 1000],
  ['YL-C002', '香薰蜡烛杯', 'Scented Candle Jar', 9, 9, 10, '陶瓷', '色釉+烫金', '黑金', 'E016', 'S006', 6, 3, 140, 40, 30, 24, 36, 3000],
  ['YL-C003', '陶瓷扩香石套装', 'Ceramic Aroma Diffuser Set', 15, 8, 12, '素烧陶', '素烧', '原色', 'E005', 'S001', 8, 4, 120, 42, 34, 28, 24, 2000],
  ['YL-J001', '贝壳首饰盘', 'Shell Jewelry Dish', 12, 10, 2, '骨瓷', '描金', '白金', 'E016', 'S002', 4.5, 2.5, 100, 40, 30, 20, 72, 3000],
  ['YL-J002', '星空釉收纳罐', 'Starry Glaze Storage Jar', 10, 10, 14, '陶瓷', '窑变釉', '星空蓝', 'E005', 'S006', 10, 5, 160, 44, 44, 32, 24, 1000],
  ['YL-J003', '手绘猫咪调味罐', 'Hand-painted Cat Spice Jars', 8, 8, 11, '陶瓷', '手绘', '多彩', 'E005', 'S002', 6, 5, 160, 40, 32, 26, 36, 1500],
  ['YL-J004', '竹节纹茶叶罐', 'Bamboo Tea Canister', 9, 9, 13, '青瓷', '刻花', '粉青', 'E004', 'S006', 11, 7, 180, 46, 46, 30, 24, 800],
];

/** 新增物料 [编码, 名称, 类别, 单位, 库存, 成本, 安全, 上限] / extra materials */
const MATERIALS = [
  ['M-CL-02', '紫砂泥', '陶土', 'kg', 300, 12, 100, 1500],
  ['M-GL-02', '青花料', '色料', 'kg', 15, 260, 5, 60],
  ['M-GL-03', '金水', '色料', 'g', 800, 9.5, 300, 3000],
  ['M-GL-04', '色釉（混色）', '釉料', 'kg', 120, 26, 60, 600],
  ['P-INS-01', '珍珠棉内衬', '包装耗材', '个', 1500, 0.6, 500, 8000],
  ['P-LBL-01', '吊牌/贴标', '包装耗材', '个', 6000, 0.08, 1000, 20000],
  ['A-LED-01', 'LED暖光灯串', '配件', '个', 0, 3.8, 200, 3000],
  ['A-MTL-01', '金属托架', '配件', '个', 120, 5.5, 100, 2000],
];

/** 港口、船名、工人 / ports, vessels, workers */
const VESSELS = ['COSCO SHIPPING ARIES 041E', 'MSC ISABELLA 2K3W', 'EVER GIVEN 118W', 'CMA CGM JULES VERNE 0FL3', 'OOCL HONG KONG 087E', 'MAERSK EINDHOVEN 245W'];
const WORKERS = ['王师傅', '李班长', '张阿姨', '陈师傅', '刘班长', '黄师傅'];

module.exports = { STAFF, MAILBOX, CUSTOMERS, SUPPLIERS, AGENCIES, SAMPLES, MATERIALS, VESSELS, WORKERS };

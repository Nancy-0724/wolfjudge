/*
 * 狼人殺自動法官 V1.5.0
 * 無外部函式庫、後端或網路請求；使用 GitHub Pages 即可。
 *
 * 區段：①角色與純規則 ②狀態轉換 ③儲存/語音/計時 ④畫面 ⑤事件。
 * 所有身份留在閉包與本機儲存；遊戲中不提供完整身份或紀錄入口。
 * 同機輪流操作仍需玩家遵守閉眼規則，不是防開發者工具的安全系統。
 *
 * API 參考：
 * https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices
 * https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
 * https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
 */
(function () {
  'use strict';

  const VERSION = '1.5.0';
  // 只在夜間角色閉眼指令完成後緩衝；不延遲睜眼後的操作。
  const NIGHT_BUFFER_MS = 3000;
  const SCHEMA = 4;
  const RULESET = 'v1.3-five-min-evil-once-poison-first-day-retaliation';
  const MIN_PLAYERS = 5;
  const MAX_PLAYERS = 18;
  const ROLE_ORDER = ['wolf', 'wolfking', 'evilknight', 'villager', 'seer', 'witch', 'hunter', 'guard', 'knight'];

  // 擴充入口一：角色定義。新增角色亦須新增其規則、互動頁面與測試。
  const ROLES = Object.freeze({
    wolf: {
      name: '普通狼人', seal: '狼', camp: 'wolf', category: 'wolf', max: MAX_PLAYERS,
      summary: '每晚共同襲擊一人',
      description: '與狼人陣營隊友每晚共同襲擊一人，可自刀。白天發言時點自己的號碼可自爆；沒有遺言，取消當日投票。',
      deathSkill: null, selfDestruct: true
    },
    wolfking: {
      name: '狼王', seal: '王', camp: 'wolf', category: 'wolf', max: 1,
      summary: '狼刀、自爆、死亡帶人',
      description: '參與狼人共同襲擊。被刀、放逐、技能帶走、同守同救或自爆可帶人；被毒、被決鬥不可帶人。最後狼人出局已終局時，不再帶人。',
      deathSkill: 'take_player', lastStand: false, selfDestruct: true
    },
    evilknight: {
      name: '惡靈騎士', seal: '靈', camp: 'wolf', category: 'wolf', max: 1,
      summary: '夜間免死，一次被動反傷',
      description: '參與共同狼刀，不可自爆。夜間狼刀、毒藥、同守同救無法殺死你；一次被動反傷只對查驗或下毒生效，同晚驗毒優先反傷女巫。守護與解藥不觸發。天亮後的放逐、決鬥與帶人可使你出局。',
      deathSkill: null, selfDestruct: false, nightImmune: true
    },
    guard: {
      name: '守衛', seal: '守', camp: 'good', category: 'god', max: 1,
      summary: '每晚守護，可自守不可連守',
      description: '每晚守護一人或空守，可守自己，不可連續兩晚守同一人。只防一般狼刀；同守同救仍死亡。自己同晚死亡不取消已確認守護。',
      deathSkill: null
    },
    knight: {
      name: '騎士', seal: '騎', camp: 'good', category: 'god', max: 1,
      summary: '白天一次決鬥',
      description: '整局一次，在白天發言時點自己的號碼決鬥。選到狼人陣營則對方死亡並結束白天；選到好人則自己死亡、繼續白天。決鬥死者沒有遺言。',
      deathSkill: null
    },
    villager: {
      name: '村民', seal: '民', camp: 'good', category: 'villager', max: MAX_PLAYERS,
      summary: '白天討論與投票',
      description: '夜間沒有操作。根據發言與線索，在白天找出狼人。',
      deathSkill: null
    },
    seer: {
      name: '預言家', seal: '預', camp: 'good', category: 'god', max: 1,
      summary: '每晚查驗一人',
      description: '每晚查驗一名其他存活玩家，只得知「好人」或「狼人」。可以重複查驗。',
      deathSkill: null
    },
    witch: {
      name: '女巫', seal: '巫', camp: 'good', category: 'god', max: 1,
      summary: '解藥、毒藥各一次',
      description: '解藥、毒藥各一瓶；不可自救或自毒，同晚只用一瓶。只有解藥尚在時可看狼刀目標，解藥用完後不再顯示號碼。',
      deathSkill: null
    },
    hunter: {
      name: '獵人', seal: '獵', camp: 'good', category: 'god', max: 1,
      summary: '符合死亡條件可帶人',
      description: '被狼刀、放逐、帶人技能或同守同救致死時，可帶走一名存活玩家。死因含毒藥不能發動；即使已屠邊，仍先保留你的合法反擊。',
      deathSkill: 'take_player', lastStand: true
    }
  });

  // 本版惡靈騎士採用值（不同玩法可能不同，開局規則亦有明示）：
  // 反傷只一次；同晚驗毒優先女巫；守救不能擋反傷；守護/解藥不觸發。
  // 免疫僅適用 resolveNight 的傷害；本網站在 DAWN 之後才處理的帶人屬白天。
  // 沿用全存活號碼選狼刀，刀中惡靈無效，不另外標記其身份。
  const EVIL_RULES = Object.freeze({ reflectionPriority: 'witch', reflectionLimit: 1,
    guardTriggers: false, selfDestruct: false, daylightRetaliationCanKill: true });

  // 擴充入口二：只安排本局有配置的夜間角色。已配置但死亡者仍保留時段。
  const NIGHT_STEPS = Object.freeze([
    { role: 'guard', label: '守衛', wake: 'GUARD_WAKE', sleep: 'GUARD_SLEEP', select: 'GUARD_SELECT',
      openText: '守衛請睜眼。請選擇今晚要守護的玩家，或選擇不守護。', closeText: '守衛請閉眼。' },
    { role: 'wolf', label: '狼人', wake: 'WOLF_WAKE', sleep: 'WOLF_SLEEP', select: 'WOLF_SELECT',
      openText: '狼人請睜眼。請選擇今晚要襲擊的玩家。', closeText: '狼人請閉眼。' },
    { role: 'seer', label: '預言家', wake: 'SEER_WAKE', sleep: 'SEER_SLEEP', select: 'SEER_SELECT',
      openText: '預言家請睜眼。請選擇今晚要查驗的玩家。', closeText: '預言家請閉眼。' },
    { role: 'witch', label: '女巫', wake: 'WITCH_WAKE', sleep: 'WITCH_SLEEP', select: 'WITCH_HEAL',
      openText: '女巫請睜眼。請查看畫面，決定是否使用藥品。', closeText: '女巫請閉眼。' }
  ]);

  // 擴充入口三：通用死亡技能。UI 不使用角色名稱或特有的「開槍」字眼。
  const DEATH_SKILLS = Object.freeze({
    take_player: {
      eligible(player, death) {
        return !player.skills.deathUsed &&
          !death.causes.includes('witch_poison') &&
          !death.causes.includes('knight_duel') &&
          death.causes.some(cause => ['wolf', 'vote', 'death_skill', 'guard_heal',
            ...(player.role === 'wolfking' ? ['self_destruct'] : [])].includes(cause));
      }
    }
  });

  const AUTO_PHASES = new Set([
    'NIGHT_START', 'GUARD_WAKE', 'GUARD_SLEEP', 'WOLF_WAKE', 'WOLF_SLEEP', 'SEER_WAKE', 'SEER_SLEEP',
    'WITCH_WAKE', 'WITCH_SLEEP', 'NIGHT_RESOLVE', 'DAWN'
  ]);
  const SELECT_PHASES = new Set([
    'GUARD_SELECT', 'WOLF_SELECT', 'SEER_SELECT', 'WITCH_POISON', 'DEATH_SKILL_SELECT', 'DAY_VOTE_RESULT', 'KNIGHT_SELECT'
  ]);
  const PHASES = new Set([
    'ROLE_HANDOFF', 'ROLE_REVEAL', 'ROLE_COMPLETE', ...AUTO_PHASES,
    ...SELECT_PHASES, 'GUARD_CONFIRM', 'WOLF_CONFIRM', 'SEER_CONFIRM', 'SEER_RESULT', 'SEER_PASS_CONFIRM',
    'WITCH_HEAL', 'WITCH_HEAL_CONFIRM', 'WITCH_POISON_CONFIRM', 'WITCH_PASS_CONFIRM',
    'WITCH_DONE', 'NIGHT_WAIT', 'NIGHT_RESULT', 'LAST_WORDS',
    'DEATH_SKILL_DECISION', 'DEATH_SKILL_PASS_CONFIRM', 'DEATH_SKILL_CONFIRM',
    'DEATH_SKILL_RESULT', 'DAY_DISCUSSION', 'DAY_VOTE_CONFIRM', 'DAY_EXECUTION',
    'DAY_NO_EXECUTION', 'NEXT_NIGHT', 'GAME_OVER', 'GAME_ROLES', 'GAME_HISTORY',
    'DAY_ACTION_DECISION', 'DAY_ACTION_UNAVAILABLE', 'KNIGHT_CONFIRM', 'SELF_DESTRUCT_CONFIRM', 'DAY_ACTION_RESULT'
  ]);

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function integer(value) { return Number.isInteger(value); }
  function playerById(game, id) { return game.players.find(p => p.id === id); }
  function roleActor(game, role) {
    if (!game.night) return null;
    return game.players.find(p => p.role === role && game.night.aliveAtStart.includes(p.id)) || null;
  }
  function configuredNightSteps(game) {
    return NIGHT_STEPS.filter(step => step.role === 'wolf'
      ? ROLE_ORDER.some(role => ROLES[role].camp === 'wolf' && game.config.roles[role] > 0)
      : (game.config.roles[step.role] || 0) > 0);
  }
  function nightBufferKey(game) {
    return `buffer:${game.round}:${game.phase}`;
  }
  function isNightClosing(game) {
    return !!game && game.status === 'playing' && NIGHT_STEPS.some(step => step.sleep === game.phase);
  }
  function isNightBuffer(game, candidate) {
    return isNightClosing(game) && candidate?.kind === 'buffer' && candidate.key === nightBufferKey(game) &&
      candidate.total === NIGHT_BUFFER_MS && Number.isFinite(candidate.remaining) &&
      candidate.remaining >= 0 && candidate.remaining <= NIGHT_BUFFER_MS;
  }
  function maySkipSeer(game) {
    // 根據開局配置固定顯示；不能隨惡靈死亡或反傷已使用而改變，避免洩漏狀態。
    return (game.config.roles.evilknight || 0) > 0;
  }
  function nightOpenText(game, step) {
    return step.role === 'seer' && maySkipSeer(game)
      ? '預言家請睜眼。請選擇今晚要查驗的玩家，或選擇不查驗。'
      : step.openText;
  }
  function activeStep(game) { return NIGHT_STEPS.find(s => s.role === game.night?.activeRole); }
  function isNight(game) {
    return !!game && game.status === 'playing' &&
      (game.phase === 'NIGHT_START' || game.phase === 'NIGHT_RESOLVE' ||
        game.phase === 'NIGHT_WAIT' || /^(GUARD|WOLF|SEER|WITCH)_/.test(game.phase));
  }
  function isSlotPhase(game) {
    return isNight(game) && !AUTO_PHASES.has(game.phase);
  }
  function log(game, type, data = {}) {
    game.history.push({ seq: game.history.length + 1, round: game.round,
      period: isNight(game) ? 'night' : 'day', type, ...data });
  }
  function expect(game, ...phases) {
    assert(phases.includes(game.phase), '目前階段無法執行這個操作，請依畫面繼續。');
  }

  function configErrors(config) {
    const errors = [];
    if (!config || !integer(config.playerCount) || config.playerCount < MIN_PLAYERS || config.playerCount > MAX_PLAYERS) {
      return [`玩家人數須介於 ${MIN_PLAYERS}～${MAX_PLAYERS} 人。`];
    }
    let total = 0;
    for (const role of ROLE_ORDER) {
      const value = config.roles?.[role];
      if (!integer(value) || value < 0 || value > ROLES[role].max) errors.push(`${ROLES[role].name}數量不正確。`);
      else total += value;
    }
    if (total !== config.playerCount) errors.push(`已配置 ${total} 位，須與 ${config.playerCount} 位玩家一致。`);
    if (!ROLE_ORDER.some(role => ROLES[role].camp === 'wolf' && config.roles?.[role] > 0)) errors.push('狼人陣營至少一名：可使用普通狼人、狼王或惡靈騎士。');
    if (!(config.roles?.villager >= 1)) errors.push('至少需要一名村民。');
    if (!ROLE_ORDER.some(role => ROLES[role].category === 'god' && config.roles?.[role] > 0)) {
      errors.push('屠邊局至少需要一名神職。');
    }
    if (![30, 45, 60, 90].includes(config.nightSeconds)) errors.push('請選擇有效的夜間操作時間。');
    return errors;
  }

  function recommendedRoles(count) {
    // 五人只是可調整的起始配置，不強制使用惡靈騎士，也不改屠邊。
    if (count === 5) return { wolf: 1, wolfking: 0, evilknight: 0, villager: 2,
      seer: 1, witch: 0, hunter: 0, guard: 1, knight: 0 };
    const wolf = count <= 8 ? 2 : count <= 11 ? 3 : count <= 14 ? 4 : 5;
    const hunter = count >= 7 ? 1 : 0;
    return { wolf, wolfking: 0, evilknight: 0, villager: count - wolf - 2 - hunter, seer: 1, witch: 1, hunter, guard: 0, knight: 0 };
  }

  function randomInt(max) {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const sample = new Uint32Array(1);
      const limit = Math.floor(4294967296 / max) * max;
      do { globalThis.crypto.getRandomValues(sample); } while (sample[0] >= limit);
      return sample[0] % max;
    }
    return Math.floor(Math.random() * max);
  }
  function shuffledRoles(config) {
    const roles = ROLE_ORDER.flatMap(role => Array(config.roles[role]).fill(role));
    for (let i = roles.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    return roles;
  }

  function createGame(config) {
    const errors = configErrors(config);
    assert(errors.length === 0, errors.join(' '));
    const roles = shuffledRoles(config);
    return {
      schema: SCHEMA, version: VERSION, ruleset: RULESET,
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: Date.now(), updatedAt: Date.now(), revision: 0,
      config: clone(config), status: 'reveal', phase: 'ROLE_HANDOFF', round: 0,
      revealIndex: 0, selected: null,
      players: roles.map((role, i) => ({
        id: i + 1, role, camp: ROLES[role].camp, category: ROLES[role].category,
        alive: true, roleViewed: false,
        skills: { heal: role === 'witch' ? 1 : 0, poison: role === 'witch' ? 1 : 0, deathUsed: false,
          duelUsed: false, reflectUsed: false, lastGuardTarget: null, lastGuardRound: 0 }
      })),
      night: null, vote: null, resolution: null, deathEvents: [], history: [], winner: null, ending: null,
      dayAction: null, lastDayAction: null
    };
  }

  function startNight(game) {
    game.round += 1;
    game.phase = 'NIGHT_START';
    game.selected = null;
    game.vote = null;
    game.dayAction = null; game.lastDayAction = null;
    game.resolution = null;
    game.night = {
      number: game.round, aliveAtStart: game.players.filter(p => p.alive).map(p => p.id),
      activeRole: configuredNightSteps(game)[0].role,
      completed: Object.fromEntries(NIGHT_STEPS.map(step => [step.role, !configuredNightSteps(game).includes(step)])),
      guardedTarget: null, wolfTarget: null, seerTarget: null, seerResult: null,
      healedTarget: null, poisonTarget: null, usedHealTonight: false,
      witchNote: null, seerSkipped: false, reflection: null, immunityEvents: [], deaths: [], resolved: false
    };
    log(game, 'night_start');
  }

  function canDeathSkill(game, death) {
    const player = playerById(game, death.playerId);
    const skill = player && ROLES[player.role].deathSkill;
    return !!(player && !player.alive && skill && game.players.some(p => p.alive) &&
      DEATH_SKILLS[skill]?.eligible(player, death));
  }
  function markDeath(game, playerId, causes, sourcePlayerId = null, origin = 'night') {
    const player = playerById(game, playerId);
    assert(player && player.alive, '死亡目標必須是存活玩家。');
    player.alive = false;
    const death = {
      id: game.deathEvents.length + 1, playerId, round: game.round,
      causes: [...new Set(causes)], sourcePlayerId, origin,
      lastWordsAllowed: !causes.some(c => ['knight_duel', 'knight_fail', 'self_destruct'].includes(c))
    };
    game.deathEvents.push(death);
    return death;
  }
  function makeResolution(game, deaths, context) {
    const ordered = [...deaths].sort((a, b) => a.playerId - b.playerId);
    return {
      context, returnPhase: ['night', 'knight_fail'].includes(context) ? 'DAY_DISCUSSION' : 'NEXT_NIGHT',
      lastWordsQueue: ordered.filter(d => d.lastWordsAllowed).map(d => d.playerId),
      skillQueue: ordered.filter(d => canDeathSkill(game, d)).map(d => d.id),
      currentSkill: null, lastSkillTarget: null, skipLastWords: false, pendingEnding: null
    };
  }

  /** 同晚傷害全部合併後才更新死亡；毒藥原因必須保留，不能被狼刀覆蓋。 */
  function resolveNight(game) {
    assert(game.night && !game.night.resolved, '這一夜已完成結算。');
    assert(Object.values(game.night.completed).every(Boolean), '夜間仍有操作尚未完成。');
    const n = game.night;
    const wolves = game.players.filter(p => p.camp === 'wolf' && n.aliveAtStart.includes(p.id));
    assert(wolves.length === 0 || n.wolfTarget !== null, '狼人尚未確認襲擊目標。');
    const causes = new Map();
    function add(id, cause) {
      assert(n.aliveAtStart.includes(id), '夜間目標不在本夜存活名單中。');
      causes.set(id, [...(causes.get(id) || []), cause]);
    }
    if (n.wolfTarget !== null) {
      const guarded = n.guardedTarget === n.wolfTarget;
      const healed = n.healedTarget === n.wolfTarget;
      if (guarded && healed) add(n.wolfTarget, 'guard_heal');
      else if (!guarded && !healed) add(n.wolfTarget, 'wolf');
    }
    if (n.poisonTarget !== null) add(n.poisonTarget, 'witch_poison');

    // 反傷不在預言家畫面即時消耗：必須等女巫完成後，按固定優先序處理。
    // 所有行動以入夜時存活為準；同夜被刀/被反傷不取消已確認的行動。
    const evil = roleActor(game, 'evilknight');
    if (evil) {
      if (!evil.skills.reflectUsed) {
        const witch = roleActor(game, 'witch');
        const seer = roleActor(game, 'seer');
        const poisoned = witch && n.poisonTarget === evil.id;
        const checked = seer && !n.seerSkipped && n.seerTarget === evil.id;
        const victim = poisoned ? witch : checked ? seer : null;
        if (victim) {
          const trigger = poisoned ? 'witch_poison' : 'seer_check';
          evil.skills.reflectUsed = true;
          n.reflection = { sourcePlayerId: evil.id, targetPlayerId: victim.id, trigger };
          // 不經狼刀的守護/解藥判斷；即使同時有其他死因，也只計一名死者。
          add(victim.id, 'evil_reflect');
          log(game, 'evil_reflect', { source: evil.id, target: victim.id, trigger });
        }
      }
      // 永久夜間免疫和一次反傷分開記錄。免疫不消耗、不依賴反傷次數。
      if (causes.has(evil.id)) {
        const blocked = [...causes.get(evil.id)];
        n.immunityEvents.push({ playerId: evil.id, causes: blocked });
        causes.delete(evil.id);
        log(game, 'evil_immune', { target: evil.id, causes: blocked });
      }
    }
    const deaths = [...causes.entries()].sort((a, b) => a[0] - b[0])
      .map(([id, list]) => markDeath(game, id, list,
        list.includes('evil_reflect') ? n.reflection.sourcePlayerId : null, 'night'));
    n.deaths = deaths.map(d => d.id);
    n.resolved = true;
    game.resolution = makeResolution(game, deaths, 'night');
    log(game, 'night_result', { deaths: deaths.map(d => d.playerId) });
  }

  function getWinner(game) {
    const alive = game.players.filter(p => p.alive);
    const counts = {
      wolf: alive.filter(p => p.camp === 'wolf').length,
      villager: alive.filter(p => p.category === 'villager').length,
      god: alive.filter(p => p.category === 'god').length
    };
    if (counts.wolf === 0) return { camp: 'good', reason: 'wolves_eliminated', counts };
    if (counts.villager === 0) return { camp: 'wolf', reason: 'villagers_eliminated', counts };
    if (counts.god === 0) return { camp: 'wolf', reason: 'gods_eliminated', counts };
    return null;
  }

  /** B 規則：勝利條件成立仍保留獵人的合法反擊；狼王沒有此優先權。
   * 不在夜間選人途中判勝負，只在完整死亡批次後呼叫。
   * 回傳 false 可能代表尚未終局，也可能代表等待獵人反擊；不得據此補回遺言。
   */
  function endIfWinner(game, source = null, playerIds = []) {
    if (game.status === 'finished') return true;
    const winner = getWinner(game);
    if (!winner) return false;
    const r = game.resolution;
    const ending = source ? { source, playerIds: [...playerIds], round: game.round } :
      r?.pendingEnding || { source: null, playerIds: [], round: game.round };
    if (r) {
      r.pendingEnding = ending;
      r.skipLastWords = true;
      r.lastWordsQueue = [];
      const isLastStand = id => {
        const death = game.deathEvents.find(d => d.id === id);
        const player = death && playerById(game, death.playerId);
        return player && ROLES[player.role].lastStand === true && canDeathSkill(game, death);
      };
      r.skillQueue = r.skillQueue.filter(isLastStand);
      if (!isLastStand(r.currentSkill)) r.currentSkill = null;
      if (r.currentSkill !== null || r.skillQueue.length) return false;
    }
    game.winner = winner;
    game.ending = ending;
    game.status = 'finished'; game.phase = 'GAME_OVER'; game.selected = null;
    if (r) { r.lastWordsQueue = []; r.skillQueue = []; r.currentSkill = null; }
    log(game, 'game_over', { winner: winner.camp, reason: winner.reason,
      period: ending.source === 'night' ? 'night' : 'day' });
    return true;
  }

  function finishResolution(game) {
    if (endIfWinner(game)) return;
    const r = game.resolution;
    assert(r && !r.lastWordsQueue.length && !r.skillQueue.length && r.currentSkill === null,
      '請先完成所有待處理的死亡流程。');
    game.phase = r.returnPhase;
    game.selected = null; game.dayAction = null;
  }

  function advanceResolution(game) {
    if (endIfWinner(game)) return;
    const r = game.resolution;
    assert(r, '尚未建立死亡流程。');
    if (r.currentSkill !== null) {
      const death = currentDeath(game);
      if (death && canDeathSkill(game, death)) { game.phase = 'DEATH_SKILL_DECISION'; return; }
      r.currentSkill = null;
    }
    if (!r.skipLastWords && r.lastWordsQueue.length) { game.phase = 'LAST_WORDS'; return; }
    while (r.skillQueue.length) {
      const id = r.skillQueue.shift();
      const death = game.deathEvents.find(d => d.id === id);
      if (death && canDeathSkill(game, death)) {
        r.currentSkill = id; game.phase = 'DEATH_SKILL_DECISION'; game.selected = null; return;
      }
    }
    finishResolution(game);
  }
  function currentDeath(game) {
    return game.deathEvents.find(d => d.id === game.resolution?.currentSkill) || null;
  }

  function eligibleTargets(game) {
    let ids = game.players.filter(p => p.alive).map(p => p.id);
    if (/^(GUARD|WOLF|SEER|WITCH)_/.test(game.phase)) ids = [...game.night.aliveAtStart];
    if (game.phase.startsWith('GUARD_')) {
      const actor = roleActor(game, 'guard');
      const last = actor?.skills.lastGuardRound === game.round - 1 ? actor.skills.lastGuardTarget : null;
      ids = actor ? ids.filter(id => id !== last) : [];
    }
    if (game.phase.startsWith('KNIGHT_')) {
      ids = ids.filter(id => id !== game.dayAction?.actorId);
    }
    if (game.phase.startsWith('SEER_')) {
      const actor = roleActor(game, 'seer');
      ids = actor ? ids.filter(id => id !== actor.id) : [];
    }
    if (game.phase.startsWith('WITCH_POISON')) {
      const actor = roleActor(game, 'witch');
      ids = actor ? ids.filter(id => id !== actor.id) : [];
    }
    return ids;
  }
  function requireTarget(game) {
    assert(integer(game.selected) && eligibleTargets(game).includes(game.selected), '請選擇有效的存活玩家。');
    return game.selected;
  }
  function completeRole(game, role, waitForSlot = false) {
    game.night.completed[role] = true;
    game.selected = null;
    // 真正完成操作立即閉眼；無存活行動者才保留原本的等待時段。
    game.phase = waitForSlot ? 'NIGHT_WAIT' : NIGHT_STEPS.find(step => step.role === role).sleep;
  }

  const DAY_ACTION_PHASES = new Set(['DAY_DISCUSSION', 'DAY_ACTION_DECISION', 'DAY_ACTION_UNAVAILABLE',
    'KNIGHT_SELECT', 'KNIGHT_CONFIRM', 'SELF_DESTRUCT_CONFIRM']);
  function availableDayAction(game, playerId) {
    const p = playerById(game, playerId);
    if (game.status !== 'playing' || !DAY_ACTION_PHASES.has(game.phase) || !p?.alive) return null;
    if (p.role === 'knight' && !p.skills.duelUsed) return 'duel';
    if (ROLES[p.role].selfDestruct === true) return 'self_destruct';
    return null;
  }
  function requireDayActor(game, kind) {
    const id = game.dayAction?.actorId;
    assert(availableDayAction(game, id) === kind, '現在無法執行此操作。');
    return playerById(game, id);
  }

  /** 原子式 reducer：確認動作成功才回傳新狀態；錯誤不會扣藥或留下半份資料。 */
  function transition(previous, action) {
    assert(previous && PHASES.has(previous.phase), '遊戲狀態不正確。');
    const g = clone(previous);
    const type = action?.type;
    switch (type) {
      case 'REVEAL':
        expect(g, 'ROLE_HANDOFF'); g.phase = 'ROLE_REVEAL'; break;
      case 'REMEMBER':
        expect(g, 'ROLE_REVEAL');
        g.players[g.revealIndex].roleViewed = true;
        g.revealIndex += 1;
        g.phase = g.revealIndex < g.players.length ? 'ROLE_HANDOFF' : 'ROLE_COMPLETE';
        break;
      case 'START':
        expect(g, 'ROLE_COMPLETE');
        assert(g.players.every(p => p.roleViewed), '請先完成所有身份確認。');
        g.status = 'playing'; startNight(g); break;
      case 'AUTO': {
        assert(AUTO_PHASES.has(g.phase), '此階段不會自動前進。');
        if (g.phase === 'NIGHT_START') g.phase = configuredNightSteps(g)[0].wake;
        else if (g.phase === 'NIGHT_RESOLVE') {
          resolveNight(g);
          // 先讓所有人睜眼；不在閉眼畫面播技能或獲勝提示。
          g.phase = 'DAWN';
        }
        else if (g.phase === 'DAWN') {
          const ids = g.night.deaths.map(id => g.deathEvents.find(d => d.id === id).playerId);
          g.phase = 'NIGHT_RESULT';
          endIfWinner(g, 'night', ids);
        }
        else {
          const wakeStep = NIGHT_STEPS.find(s => s.wake === g.phase);
          const sleepStep = NIGHT_STEPS.find(s => s.sleep === g.phase);
          if (wakeStep) {
            const role = wakeStep.role;
            g.night.activeRole = role;
            const available = role === 'wolf'
              ? g.players.some(p => p.camp === 'wolf' && g.night.aliveAtStart.includes(p.id))
              : !!roleActor(g, role);
            if (available) {
              g.phase = wakeStep.select;
              // 解藥用完：不走狼刀目標頁，連本人被刀也不透露。
              if (role === 'witch' && roleActor(g, 'witch').skills.heal === 0) {
                if (roleActor(g, 'witch').skills.poison > 0) g.phase = 'WITCH_POISON';
                else { g.night.witchNote = 'empty'; g.phase = 'WITCH_DONE'; log(g, 'witch_pass'); }
              }
            }
            else { log(g, 'role_inactive', { role }); completeRole(g, role, true); }
          } else if (sleepStep) {
            const steps = configuredNightSteps(g);
            const next = steps[steps.indexOf(sleepStep) + 1];
            if (next) { g.night.activeRole = next.role; g.phase = next.wake; }
            else g.phase = 'NIGHT_RESOLVE';
          }
        }
        break;
      }
      case 'FINISH_SLOT':
        expect(g, 'NIGHT_WAIT');
        assert(g.night.completed[g.night.activeRole], '本階段尚未完成。');
        g.phase = activeStep(g).sleep; break;
      case 'SELECT':
        assert(SELECT_PHASES.has(g.phase), '目前不是選擇目標階段。');
        if (['DAY_VOTE_RESULT', 'GUARD_SELECT'].includes(g.phase) && action.id === 0) g.selected = 0;
        else {
          assert(integer(action.id) && eligibleTargets(g).includes(action.id), '這個號碼目前不可選。');
          g.selected = action.id;
        }
        break;
      case 'REVIEW': {
        assert(SELECT_PHASES.has(g.phase), '目前不是選擇目標階段。');
        if (['DAY_VOTE_RESULT', 'GUARD_SELECT'].includes(g.phase) && g.selected === 0) { /* 無人出局／空守 */ }
        else requireTarget(g);
        const targets = { GUARD_SELECT: 'GUARD_CONFIRM', KNIGHT_SELECT: 'KNIGHT_CONFIRM', WOLF_SELECT: 'WOLF_CONFIRM', SEER_SELECT: 'SEER_CONFIRM',
          WITCH_POISON: 'WITCH_POISON_CONFIRM', DEATH_SKILL_SELECT: 'DEATH_SKILL_CONFIRM',
          DAY_VOTE_RESULT: 'DAY_VOTE_CONFIRM' };
        g.phase = targets[g.phase]; break;
      }
      case 'BACK': {
        const routes = { GUARD_CONFIRM: 'GUARD_SELECT', KNIGHT_CONFIRM: 'KNIGHT_SELECT', KNIGHT_SELECT: 'DAY_ACTION_DECISION',
          SELF_DESTRUCT_CONFIRM: 'DAY_ACTION_DECISION', WOLF_CONFIRM: 'WOLF_SELECT', SEER_CONFIRM: 'SEER_SELECT',
          SEER_PASS_CONFIRM: 'SEER_SELECT',
          WITCH_HEAL_CONFIRM: 'WITCH_HEAL', WITCH_POISON_CONFIRM: 'WITCH_POISON',
          WITCH_PASS_CONFIRM: 'WITCH_POISON', DEATH_SKILL_SELECT: 'DEATH_SKILL_DECISION',
          DEATH_SKILL_CONFIRM: 'DEATH_SKILL_SELECT', DEATH_SKILL_PASS_CONFIRM: 'DEATH_SKILL_DECISION',
          DAY_VOTE_CONFIRM: 'DAY_VOTE_RESULT', GAME_ROLES: 'GAME_OVER', GAME_HISTORY: 'GAME_OVER' };
        assert(routes[g.phase], '此操作已確認，不能回到前一個玩家或撤銷。');
        g.phase = routes[g.phase]; break;
      }
      case 'CONFIRM_GUARD': {
        expect(g, 'GUARD_CONFIRM');
        const actor = roleActor(g, 'guard');
        assert(actor, '目前沒有可操作的守衛。');
        const id = g.selected === 0 ? null : requireTarget(g);
        g.night.guardedTarget = id;
        actor.skills.lastGuardTarget = id; actor.skills.lastGuardRound = g.round;
        log(g, 'guard_protect', { source: actor.id, target: id });
        completeRole(g, 'guard'); break;
      }
      case 'CONFIRM_WOLF':
        expect(g, 'WOLF_CONFIRM'); g.night.wolfTarget = requireTarget(g);
        log(g, 'wolf_attack', { target: g.night.wolfTarget }); completeRole(g, 'wolf'); break;
      case 'CONFIRM_SEER': {
        expect(g, 'SEER_CONFIRM');
        const id = requireTarget(g);
        assert(roleActor(g, 'seer'), '目前沒有可操作的預言家。');
        g.night.seerTarget = id; g.night.seerSkipped = false;
        g.night.seerResult = playerById(g, id).camp;
        log(g, 'seer_check', { target: id, result: g.night.seerResult });
        g.phase = 'SEER_RESULT'; g.selected = null; break;
      }
      case 'PASS_SEER':
        expect(g, 'SEER_SELECT');
        assert(maySkipSeer(g) && roleActor(g, 'seer'), '本局不可略過查驗。');
        g.phase = 'SEER_PASS_CONFIRM'; break;
      case 'CONFIRM_PASS_SEER':
        expect(g, 'SEER_PASS_CONFIRM');
        assert(maySkipSeer(g) && roleActor(g, 'seer'), '本局不可略過查驗。');
        g.night.seerTarget = null; g.night.seerResult = null; g.night.seerSkipped = true;
        log(g, 'seer_pass'); completeRole(g, 'seer'); break;
      case 'ACK_SEER':
        expect(g, 'SEER_RESULT'); completeRole(g, 'seer'); break;
      case 'CHOOSE_HEAL': {
        expect(g, 'WITCH_HEAL'); const witch = roleActor(g, 'witch');
        assert(witch && witch.skills.heal > 0, '解藥已使用。');
        assert(g.night.wolfTarget !== null && g.night.wolfTarget !== witch.id, '女巫任何一晚都不可自救。');
        assert(!g.night.poisonTarget && !g.night.usedHealTonight, '同一晚只能使用一瓶藥。');
        g.phase = 'WITCH_HEAL_CONFIRM'; break;
      }
      case 'CONFIRM_HEAL': {
        expect(g, 'WITCH_HEAL_CONFIRM'); const witch = roleActor(g, 'witch');
        assert(witch && witch.skills.heal > 0 && g.night.wolfTarget !== null &&
          g.night.wolfTarget !== witch.id && !g.night.poisonTarget && !g.night.usedHealTonight,
          '這次解藥操作不符合規則。');
        witch.skills.heal -= 1; g.night.healedTarget = g.night.wolfTarget;
        g.night.usedHealTonight = true; g.night.witchNote = 'heal';
        log(g, 'witch_heal', { target: g.night.healedTarget });
        g.phase = 'WITCH_DONE'; break;
      }
      case 'SKIP_HEAL': {
        expect(g, 'WITCH_HEAL'); const witch = roleActor(g, 'witch');
        assert(witch, '目前沒有可操作的女巫。');
        if (witch.skills.poison > 0) { g.phase = 'WITCH_POISON'; g.selected = null; }
        else { g.night.witchNote = 'empty'; g.phase = 'WITCH_DONE'; log(g, 'witch_pass'); }
        break;
      }
      case 'PASS_POISON':
        expect(g, 'WITCH_POISON'); g.phase = 'WITCH_PASS_CONFIRM'; break;
      case 'CONFIRM_PASS':
        expect(g, 'WITCH_PASS_CONFIRM'); log(g, 'witch_pass'); completeRole(g, 'witch'); break;
      case 'CONFIRM_POISON': {
        expect(g, 'WITCH_POISON_CONFIRM'); const witch = roleActor(g, 'witch');
        assert(witch && witch.skills.poison > 0 && !g.night.usedHealTonight, '本晚不可使用毒藥。');
        const id = requireTarget(g); assert(id !== witch.id, '不可對自己使用毒藥。');
        witch.skills.poison -= 1; g.night.poisonTarget = id; g.night.witchNote = 'poison';
        log(g, 'witch_poison', { target: id }); g.selected = null; g.phase = 'WITCH_DONE'; break;
      }
      case 'ACK_WITCH':
        expect(g, 'WITCH_DONE'); completeRole(g, 'witch'); break;
      case 'CONTINUE_RESULT':
        expect(g, 'NIGHT_RESULT', 'DAY_EXECUTION', 'DEATH_SKILL_RESULT', 'DAY_ACTION_RESULT'); advanceResolution(g); break;
      case 'ACK_WORDS': {
        expect(g, 'LAST_WORDS');
        const id = g.resolution.lastWordsQueue.shift();
        log(g, 'last_words', { playerId: id }); advanceResolution(g); break;
      }
      case 'ACTIVATE_SKILL': {
        expect(g, 'DEATH_SKILL_DECISION');
        assert(currentDeath(g) && canDeathSkill(g, currentDeath(g)), '目前沒有可啟動的技能。');
        g.phase = 'DEATH_SKILL_SELECT'; g.selected = null; break;
      }
      case 'PASS_SKILL':
        expect(g, 'DEATH_SKILL_DECISION'); g.phase = 'DEATH_SKILL_PASS_CONFIRM'; break;
      case 'CONFIRM_PASS_SKILL': {
        expect(g, 'DEATH_SKILL_PASS_CONFIRM'); const death = currentDeath(g);
        assert(death && canDeathSkill(g, death), '技能已處理。');
        playerById(g, death.playerId).skills.deathUsed = true;
        log(g, 'death_skill_pass', { source: death.playerId });
        g.resolution.currentSkill = null; advanceResolution(g); break;
      }
      case 'CONFIRM_SKILL': {
        expect(g, 'DEATH_SKILL_CONFIRM'); const death = currentDeath(g);
        assert(death && canDeathSkill(g, death), '這次死亡不能啟動技能。');
        const target = requireTarget(g);
        playerById(g, death.playerId).skills.deathUsed = true;
        const newDeath = markDeath(g, target, ['death_skill'], death.playerId, g.resolution.context);
        log(g, 'death_skill', { source: death.playerId, target,
          skill: ROLES[playerById(g, death.playerId).role].deathSkill });
        g.resolution.currentSkill = null;
        g.resolution.lastSkillTarget = target;
        if (!g.resolution.skipLastWords) g.resolution.lastWordsQueue.push(target);
        // 新死亡先完成連鎖，再處理同批次其他待啟動技能。
        if (canDeathSkill(g, newDeath)) g.resolution.skillQueue.unshift(newDeath.id);
        g.phase = 'DEATH_SKILL_RESULT'; g.selected = null;
        endIfWinner(g, 'skill', [target]); break;
      }
      case 'OPEN_DAY_ACTION': {
        expect(g, 'DAY_DISCUSSION');
        assert(integer(action.id) && playerById(g, action.id)?.alive, '請選擇自己的存活號碼。');
        const kind = availableDayAction(g, action.id);
        g.dayAction = { actorId: action.id, kind };
        g.selected = null;
        g.phase = kind ? 'DAY_ACTION_DECISION' : 'DAY_ACTION_UNAVAILABLE'; break;
      }
      case 'CANCEL_DAY_ACTION':
        assert(DAY_ACTION_PHASES.has(g.phase) && g.phase !== 'DAY_DISCUSSION', '動作已確認，不能撤銷。');
        g.dayAction = null; g.selected = null; g.phase = 'DAY_DISCUSSION'; break;
      case 'START_DAY_ACTION': {
        expect(g, 'DAY_ACTION_DECISION');
        const kind = availableDayAction(g, g.dayAction?.actorId);
        assert(kind && kind === g.dayAction.kind, '現在沒有可啟動的技能。');
        g.selected = null; g.phase = kind === 'duel' ? 'KNIGHT_SELECT' : 'SELF_DESTRUCT_CONFIRM'; break;
      }
      case 'CONFIRM_DUEL': {
        expect(g, 'KNIGHT_CONFIRM');
        const actor = requireDayActor(g, 'duel');
        const target = requireTarget(g);
        const success = playerById(g, target).camp === 'wolf';
        actor.skills.duelUsed = true;
        const victim = success ? target : actor.id;
        const context = success ? 'knight_success' : 'knight_fail';
        const death = markDeath(g, victim, [success ? 'knight_duel' : 'knight_fail'], actor.id, 'day');
        g.resolution = makeResolution(g, [death], context);
        g.lastDayAction = { kind: 'duel', actorId: actor.id, targetId: target, victimId: victim, success };
        log(g, 'knight_duel', { source: actor.id, target, victim, success });
        g.dayAction = null; g.selected = null; g.phase = 'DAY_ACTION_RESULT';
        endIfWinner(g, 'duel', [victim]); break;
      }
      case 'CONFIRM_SELF_DESTRUCT': {
        expect(g, 'SELF_DESTRUCT_CONFIRM');
        const actor = requireDayActor(g, 'self_destruct');
        const death = markDeath(g, actor.id, ['self_destruct'], actor.id, 'day');
        g.resolution = makeResolution(g, [death], 'self_destruct');
        g.lastDayAction = { kind: 'self_destruct', actorId: actor.id, victimId: actor.id };
        log(g, 'self_destruct', { source: actor.id });
        g.dayAction = null; g.selected = null; g.phase = 'DAY_ACTION_RESULT';
        endIfWinner(g, 'self_destruct', [actor.id]); break;
      }
      case 'VOTE':
        expect(g, 'DAY_DISCUSSION'); g.phase = 'DAY_VOTE_RESULT'; g.dayAction = null; g.selected = null; break;
      case 'CONFIRM_VOTE': {
        expect(g, 'DAY_VOTE_CONFIRM');
        assert(g.selected === 0 || eligibleTargets(g).includes(g.selected), '請選擇最終投票結果。');
        const target = g.selected === 0 ? null : requireTarget(g);
        g.vote = { round: g.round, resolved: true, target };
        log(g, 'vote_result', { target });
        if (target !== null) {
          const death = markDeath(g, target, ['vote'], null, 'day');
          g.resolution = makeResolution(g, [death], 'day'); g.phase = 'DAY_EXECUTION';
          endIfWinner(g, 'vote', [target]);
        } else { g.resolution = makeResolution(g, [], 'day'); g.phase = 'DAY_NO_EXECUTION'; }
        g.selected = null; break;
      }
      case 'CONTINUE_NO_VOTE':
        expect(g, 'DAY_NO_EXECUTION'); advanceResolution(g); break;
      case 'NEXT_NIGHT':
        expect(g, 'NEXT_NIGHT'); startNight(g); break;
      case 'SHOW_ROLES':
        assert(g.status === 'finished', '遊戲結束後才可公開身份。'); g.phase = 'GAME_ROLES'; break;
      case 'SHOW_HISTORY':
        assert(g.status === 'finished', '遊戲結束後才可公開紀錄。'); g.phase = 'GAME_HISTORY'; break;
      default: throw new Error('無法辨識這個操作。');
    }
    g.revision += 1; g.updatedAt = Date.now();
    return g;
  }

  // 嚴格檢查存檔形狀，避免壞檔導致洩露身份或重複扣藥。不是反作弊驗證。
  function validGame(g) {
    try {
      if (!g || g.schema !== SCHEMA || g.ruleset !== RULESET || !PHASES.has(g.phase)) return false;
      if (configErrors(g.config).length || !['reveal', 'playing', 'finished'].includes(g.status)) return false;
      if (!Array.isArray(g.players) || g.players.length !== g.config.playerCount) return false;
      if (!Array.isArray(g.history) || !Array.isArray(g.deathEvents) || !integer(g.round) || !integer(g.revision)) return false;
      if (g.status === 'finished' && !g.winner) return false;
      if (g.status === 'playing' && (!g.night || !Array.isArray(g.night.aliveAtStart) || !g.night.completed)) return false;
      if (!integer(g.revealIndex) || g.revealIndex < 0 || g.revealIndex > g.players.length) return false;
      if (g.status !== 'reveal' && (!g.night || typeof g.night.seerSkipped !== 'boolean' ||
        !Array.isArray(g.night.immunityEvents) || !('reflection' in g.night))) return false;
      if (g.night?.reflection !== null && g.night?.reflection !== undefined) {
        const r = g.night.reflection;
        if (!integer(r.sourcePlayerId) || !integer(r.targetPlayerId) ||
          !['witch_poison', 'seer_check'].includes(r.trigger) ||
          playerById(g, r.sourcePlayerId)?.role !== 'evilknight' ||
          !['seer', 'witch'].includes(playerById(g, r.targetPlayerId)?.role)) return false;
      }
      const counts = Object.fromEntries(ROLE_ORDER.map(r => [r, 0]));
      for (let i = 0; i < g.players.length; i++) {
        const p = g.players[i];
        if (!p || p.id !== i + 1 || !ROLES[p.role] || typeof p.alive !== 'boolean' || typeof p.roleViewed !== 'boolean') return false;
        if (p.camp !== ROLES[p.role].camp || p.category !== ROLES[p.role].category || !p.skills) return false;
        if (![0, 1].includes(p.skills.heal) || ![0, 1].includes(p.skills.poison) || typeof p.skills.deathUsed !== 'boolean' ||
          typeof p.skills.duelUsed !== 'boolean' || typeof p.skills.reflectUsed !== 'boolean' || !integer(p.skills.lastGuardRound) ||
          !(p.skills.lastGuardTarget === null || integer(p.skills.lastGuardTarget))) return false;
        counts[p.role] += 1;
      }
      return ROLE_ORDER.every(r => counts[r] === g.config.roles[r]);
    } catch (_) { return false; }
  }

  /* V1.4：UI 交易層。沿用上方 V1.3 純規則，不把「預覽選擇」當成正式行動。
   * 每次提交只保存最後狀態；中間的舊確認狀態不顯示、不單獨存檔。
   * ui 是選擇／公開提示資料，不參與角色、死亡與勝負判斷。
   */
  function pageKey(g) {
    return `${g.round}:${g.phase}:${g.resolution?.lastWordsQueue?.[0] || ''}:${g.resolution?.currentSkill || ''}:${g.resolution?.lastSkillTarget || ''}`;
  }
  function defaultUI() { return { witchAction: null, alternative: null, notice: null }; }
  function publicResultNotice(g) {
    let text = '', kind = '';
    if (g.phase === 'NIGHT_RESULT') {
      const ids = g.night.deaths.map(id => g.deathEvents.find(d => d.id === id).playerId);
      text = ids.length ? `昨晚 ${ids.map(id => `${id} 號`).join('、')} 死亡` : '昨晚是平安夜';
      kind = 'night';
    } else if (g.phase === 'DAY_EXECUTION') {
      text = `${g.vote.target} 號被放逐`; kind = 'vote';
    } else if (g.phase === 'DEATH_SKILL_RESULT') {
      text = `${g.resolution.lastSkillTarget} 號玩家死亡`; kind = 'skill';
    } else if (g.phase === 'DAY_ACTION_RESULT') {
      const a = g.lastDayAction;
      text = a.kind === 'self_destruct' ? `${a.actorId} 號自爆出局，本日取消投票` :
        `${a.actorId} 號向 ${a.targetId} 號決鬥，${a.victimId} 號死亡`;
      kind = a.kind;
    } else if (g.phase === 'DAY_NO_EXECUTION') {
      text = '本輪沒有人出局'; kind = 'vote';
    }
    return text ? { text, kind, announceAt: null } : null;
  }
  function compactState(input) {
    let g = clone(input);
    g.version = VERSION;
    g.ui = { ...defaultUI(), ...(g.ui && typeof g.ui === 'object' ? g.ui : {}) };
    if (![null, 'heal', 'poison', 'pass'].includes(g.ui.witchAction)) g.ui.witchAction = null;
    if (![null, 'pass'].includes(g.ui.alternative)) g.ui.alternative = null;
    if (g.ui.notice && (typeof g.ui.notice.text !== 'string' || typeof g.ui.notice.kind !== 'string')) g.ui.notice = null;
    let notice = null;
    // 正常只需 1～3 次；上限避免錯誤存檔產生無限轉場。
    for (let i = 0; i < 12; i++) {
      const phase = g.phase;
      const result = publicResultNotice(g);
      if (result) {
        notice = result;
        g = transition(g, { type: phase === 'DAY_NO_EXECUTION' ? 'CONTINUE_NO_VOTE' : 'CONTINUE_RESULT' });
        continue;
      }
      const selection = { GUARD_CONFIRM: 'GUARD_SELECT', WOLF_CONFIRM: 'WOLF_SELECT',
        SEER_CONFIRM: 'SEER_SELECT', KNIGHT_CONFIRM: 'KNIGHT_SELECT',
        DAY_VOTE_CONFIRM: 'DAY_VOTE_RESULT', DEATH_SKILL_CONFIRM: 'DEATH_SKILL_SELECT' };
      if (selection[phase]) { g.phase = selection[phase]; continue; }
      if (phase === 'DEATH_SKILL_DECISION') {
        g = transition(g, { type: 'ACTIVATE_SKILL' }); g.ui.alternative = null; continue;
      }
      if (phase === 'DAY_ACTION_DECISION') {
        g = transition(g, { type: 'START_DAY_ACTION' }); continue;
      }
      if (phase === 'DEATH_SKILL_PASS_CONFIRM') {
        g.phase = 'DEATH_SKILL_SELECT'; g.selected = null; g.ui.alternative = 'pass'; continue;
      }
      if (phase === 'SEER_PASS_CONFIRM') {
        g.phase = 'SEER_SELECT'; g.selected = null; g.ui.alternative = 'pass'; continue;
      }
      if (phase === 'WITCH_HEAL_CONFIRM') {
        g.phase = 'WITCH_HEAL'; g.ui.witchAction = 'heal'; continue;
      }
      if (phase === 'WITCH_POISON_CONFIRM') {
        g.phase = 'WITCH_POISON'; g.ui.witchAction = 'poison'; continue;
      }
      if (phase === 'WITCH_PASS_CONFIRM') {
        g.phase = 'WITCH_POISON'; g.selected = null; g.ui.witchAction = 'pass'; continue;
      }
      if (phase === 'WITCH_DONE' && (['heal', 'poison'].includes(g.night.witchNote) ||
        (roleActor(g, 'witch')?.skills.heal > 0 || roleActor(g, 'witch')?.skills.poison > 0))) {
        // 讀取 V1.3 已成功扣藥、但停在「完成」頁的存檔時，只結束操作，不能再次扣藥。
        g = transition(g, { type: 'ACK_WITCH' }); continue;
      }
      break;
    }
    if (notice) {
      notice.announceAt = pageKey(g);
      g.ui.notice = g.status === 'finished' ? null : notice;
    }
    return g;
  }
  function interfaceTransition(previous, action) {
    let g = compactState(previous);
    const beforePhase = g.phase;
    const steps = actions => {
      for (const type of actions) g = transition(g, { type });
    };
    switch (action?.type) {
      case 'UI_SELECT': {
        if (g.phase === 'WITCH_HEAL' || g.phase === 'WITCH_POISON') {
          assert(g.ui.witchAction === 'poison', '請先選擇「毒藥・毒人」。');
          const witch = roleActor(g, 'witch');
          assert(witch && witch.skills.poison > 0 && !g.night.usedHealTonight, '本晚不能使用毒藥。');
          if (g.phase === 'WITCH_HEAL') steps(['SKIP_HEAL']);
        }
        g = transition(g, { type: 'SELECT', id: action.id });
        g.ui.alternative = null;
        break;
      }
      case 'UI_ALTERNATIVE':
        assert(['SEER_SELECT', 'DEATH_SKILL_SELECT'].includes(g.phase), '本階段沒有這個選項。');
        if (g.phase === 'SEER_SELECT') assert(maySkipSeer(g), '本局不可略過查驗。');
        g.selected = null; g.ui.alternative = 'pass';
        break;
      case 'UI_WITCH_CHOICE': {
        expect(g, 'WITCH_HEAL', 'WITCH_POISON');
        const witch = roleActor(g, 'witch');
        assert(witch && !g.night.usedHealTonight && g.night.poisonTarget === null, '本晚操作已完成。');
        assert(['heal', 'poison', 'pass'].includes(action.choice), '請選擇本晚行動。');
        if (action.choice === 'heal') {
          assert(witch.skills.heal > 0 && g.night.wolfTarget !== null && g.night.wolfTarget !== witch.id,
            '本晚不可使用解藥。');
          g.phase = 'WITCH_HEAL';
        } else if (action.choice === 'poison') {
          assert(witch.skills.poison > 0, '毒藥已用完。');
          g.phase = 'WITCH_POISON';
        }
        g.ui.witchAction = action.choice; g.selected = null;
        break;
      }
      case 'UI_COMMIT': {
        const phase = g.phase;
        if (phase === 'WITCH_HEAL' || phase === 'WITCH_POISON') {
          const choice = g.ui.witchAction;
          if (choice === 'heal') {
            g.phase = 'WITCH_HEAL'; steps(['CHOOSE_HEAL', 'CONFIRM_HEAL', 'ACK_WITCH']);
          } else if (choice === 'poison') {
            assert(g.phase === 'WITCH_POISON', '請先選擇毒殺對象。');
            steps(['REVIEW', 'CONFIRM_POISON', 'ACK_WITCH']);
          } else if (choice === 'pass') {
            const witch = roleActor(g, 'witch');
            assert(witch && !g.night.usedHealTonight && g.night.poisonTarget === null, '本晚操作已完成。');
            // 路由回既有不使用流程，不新建第二套扣藥／行動規則。
            if (g.phase === 'WITCH_HEAL') steps(['SKIP_HEAL']);
            if (g.phase === 'WITCH_DONE') steps(['ACK_WITCH']);
            else steps(['PASS_POISON', 'CONFIRM_PASS']);
          } else throw new Error('請選擇救人、毒人或今晚不用藥。');
        } else if (phase === 'DEATH_SKILL_SELECT' && g.ui.alternative === 'pass') {
          steps(['BACK', 'PASS_SKILL', 'CONFIRM_PASS_SKILL']);
        } else if (phase === 'SEER_SELECT' && g.ui.alternative === 'pass') {
          steps(['PASS_SEER', 'CONFIRM_PASS_SEER']);
        } else {
          const confirms = { GUARD_SELECT: 'CONFIRM_GUARD', WOLF_SELECT: 'CONFIRM_WOLF',
            SEER_SELECT: 'CONFIRM_SEER', KNIGHT_SELECT: 'CONFIRM_DUEL',
            DEATH_SKILL_SELECT: 'CONFIRM_SKILL', DAY_VOTE_RESULT: 'CONFIRM_VOTE' };
          assert(confirms[phase], '本階段無法提交選擇。');
          steps(['REVIEW', confirms[phase]]);
        }
        g.ui.witchAction = null; g.ui.alternative = null;
        break;
      }
      default:
        g = transition(g, action);
    }
    // UI 選擇也存檔，但不扣藥、不查驗、不標記死亡。
    if (g.revision === previous.revision) { g.revision += 1; g.updatedAt = Date.now(); }
    if (g.round !== previous.round) g.ui = defaultUI();
    // 新夜間角色不沿用前一角色的選項。
    if (beforePhase !== g.phase && AUTO_PHASES.has(g.phase)) {
      g.ui.witchAction = null; g.ui.alternative = null; g.ui.notice = null;
    }
    return compactState(g);
  }

  // Node.js 可直接測試純規則；正式瀏覽器不暴露可讀取身份的全域物件。
  if (typeof module === 'object' && module.exports) {
    module.exports = { VERSION, ROLES, NIGHT_STEPS, createGame, transition, configErrors,
      getWinner, resolveNight, canDeathSkill, eligibleTargets, validGame, recommendedRoles,
      roleActor, currentDeath, isNight, isSlotPhase, configuredNightSteps, endIfWinner,
      availableDayAction, markDeath, makeResolution, advanceResolution, startNight, ROLE_ORDER, SCHEMA, RULESET,
      MIN_PLAYERS, MAX_PLAYERS, EVIL_RULES, maySkipSeer, nightOpenText,
      interfaceTransition, compactState, pageKey, defaultUI, NIGHT_BUFFER_MS, nightBufferKey, isNightClosing, isNightBuffer };
  }
  if (typeof document === 'undefined') return;

  /* ── 瀏覽器層：設定、存檔、語音、單一計時器 ── */
  const app = document.getElementById('app');
  const toolbar = document.getElementById('toolbar');
  const footer = document.getElementById('app-footer');
  const dialog = document.getElementById('dialog');
  const pathKey = location.pathname.replace(/index\.html$/, '').replace(/\/$/, '') || '/';
  const STORAGE_KEY = `werewolf-judge:v1:${pathKey}`;
  const SETTINGS_KEY = `${STORAGE_KEY}:settings`;
  const writerId = globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random()}`;
  const defaultSettings = { audio: true, voiceURI: '', rate: 0.92, nightSeconds: 45, keepAwake: true };
  let settings = { ...defaultSettings };
  let saveIssue = '';
  let voiceIssue = '';
  let savedEnvelope = null;
  let game = null;
  let view = 'home';
  let draft = { playerCount: 8, roles: recommendedRoles(8), nightSeconds: 45 };
  let active = false;
  let paused = false;
  let pauseReason = '';
  let foreignUpdate = false;
  let clock = null;
  let clockEnd = null;
  let intervalId = null;
  let lastCheckpoint = 0;
  let flowToken = 0;
  let autoKey = null;
  let lastAnnounced = '';
  let wakeLock = null;
  let wakePending = false;
  let wakeFailed = false;
  let toastId = null;
  let dialogCallback = null;
  let lastFocus = null;
  let actionBusy = false;
  let returnTimer = null;

  const icons = {
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M11 4 5.8 8H3v8h2.8L11 20V4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
    moon: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M25.5 21A12 12 0 0 1 12 6a12 12 0 1 0 13.5 15Z"/><path d="m23 4 .9 2.7 2.8.8-2.8.9L23 11l-.8-2.6-2.7-.9 2.7-.8L23 4Z"/></svg>',
    sun: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="16" cy="16" r="6"/><path d="M16 2v5m0 18v5M2 16h5m18 0h5M6 6l3.5 3.5m13 13L26 26M6 26l3.5-3.5m13-13L26 6"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
    star: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="m16 3 3.6 9.4L29 16l-9.4 3.6L16 29l-3.6-9.4L3 16l9.4-3.6L16 3Z"/><circle cx="16" cy="16" r="3"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
  };
  const ROLE_ART = Object.freeze({
    evilknight: '<path d="M19 28c-8-7-3-17 3-22 0 8 6 8 8 12 1-6 5-8 7-14 8 7 15 15 11 24"/><path d="M17 30c0-10 30-10 30 0v12l-6 5v10H23V47l-6-5Z"/><path d="m23 34 6 4m12-4-6 4M28 45h8M29 49v8m6-8v8M10 49l7 7m30 0 7-7"/>',
    guard: '<path d="M32 5 54 14v17c0 14-10 23-22 29C20 54 10 45 10 31V14Z"/><path d="M32 12 47 18v13c0 9-6 17-15 22-9-5-15-13-15-22V18Z"/><path d="m22 31 7 7 14-15"/>',
    knight: '<path d="M17 35V24a15 15 0 0 1 30 0v11l-8 8v11H22V43ZM18 25h28M34 26l13 9-15 5M23 54h21M32 9V4"/><path d="m9 45 6 6m-8 5 11-12M48 9l8 8m-7-1 9-9"/>',
    wolfking: '<path d="m15 20-3-14 12 7 8-10 8 10 12-7-3 14Z"/><path d="m13 26-3 13 12 13 10 9 10-9 12-13-3-13-12 7H25Z"/><path d="m19 39 7 3m19-3-7 3M26 48h12l-6 6ZM19 24h26"/>',
    wolf: '<path d="m12 27-3-18 17 11h12L55 9l-3 18 3 9-12 14-11 8-11-8L9 36Z"/><path d="m15 17 4 12 8-5m22-7-4 12-8-5M18 34l8 3m20-3-8 3M21 43l11 9 11-9M27 43h10l-5 5Z"/>',
    villager: '<circle cx="32" cy="21" r="11"/><path d="M12 56v-7c0-10 8-17 20-17s20 7 20 17v7ZM22 36l10 9 10-9M22 49v7m20-7v7"/>',
    seer: '<circle cx="32" cy="27" r="18"/><path d="M24 45h16l4 9H20l4-9ZM17 58h30M22 19a12 12 0 0 1 10-5m0 10 2 5 5 2-5 2-2 5-2-5-5-2 5-2ZM51 7v8m-4-4h8M8 30v6m-3-3h6"/>',
    witch: '<path d="M12 44 28 9l15-4-6 13 16 26M17 34c10 4 20 4 30 0M14 43c11 5 24 5 36 0"/><ellipse cx="32" cy="48" rx="28" ry="8"/><path d="M27 34h10v9H27Z"/><path d="m49 18 1.5 4.5L55 24l-4.5 1.5L49 30l-1.5-4.5L43 24l4.5-1.5ZM12 10v6m-3-3h6"/>',
    hunter: '<g transform="rotate(-27 32 32)"><path d="M5 34h11l7-6h20v8H26L16 47H5ZM43 30h16v5H43M9 35v9M28 36v7h8v-7"/><path d="M32 36v4M27 21h13v5H27ZM30 26v2m7-2v2M56 30v-5"/></g>'
  });
  function roleIcon(role, size = '') {
    const art = ROLE_ART[role];
    if (!art) return '';
    return `<span class="role-icon ${size}" data-role-icon="${role}" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${art}</svg></span>`;
  }
  function roleSymbol(role) {
    return `<div class="phase-symbol role-symbol">${roleIcon(role)}</div>`;
  }
  const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function btn(label, action, kind = 'primary', extra = '') {
    return `<button type="button" class="btn ${kind}" data-action="${action}" ${extra}>${label}</button>`;
  }
  function note(text, extra = '') { return `<div class="rule-note ${extra}">${text}</div>`; }
  function symbol(name = 'star', small = false) { return `<div class="phase-symbol${small ? ' small-symbol' : ''}">${icons[name] || icons.star}</div>`; }
  function panel(content, cls = '') { return `<div class="page"><section class="panel ${cls}">${content}</section></div>`; }
  function heading(title, subtitle = '', eyebrow = '', center = false) {
    return `<div class="page-intro${center ? ' center' : ''}">${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ''}<h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>`;
  }
  function targetDisplay(id, label = '') {
    return `<div class="target-display">${label ? `<p class="small muted">${label}</p>` : ''}<div class="big-player">${id}<small>號</small></div></div>`;
  }
  function totalConfigured() { return Object.values(draft.roles).reduce((sum, value) => sum + value, 0); }
  function stepTrack(n) { return `<div class="step-track" aria-label="設定步驟 ${n} / 3">${[1, 2, 3].map(i => `<span class="${i <= n ? 'active' : ''}"></span>`).join('')}</div>`; }
  // 陣營樣式只用於公開配置與私人身份卡，絕不套用到白天號碼／通用技能介面。
  const CAMP_PRESENTATION = Object.freeze({
    wolf: { name: '狼人陣營', side: '壞人方', headline: '你是壞人',
      goal: '目標：讓村民全滅，或神職全滅。' },
    good: { name: '好人陣營', side: '好人方', headline: '你是好人',
      goal: '目標：淘汰所有狼人陣營玩家。' }
  });
  function campHeader(config, camp) {
    const info = CAMP_PRESENTATION[camp];
    const roles = ROLE_ORDER.filter(role => ROLES[role].camp === camp);
    const total = roles.reduce((sum, role) => sum + config.roles[role], 0);
    const villagers = config.roles.villager;
    const detail = camp === 'wolf' ? '壞人方' : `村民 ${villagers} 人 · 神職 ${total - villagers} 人`;
    return `<header class="camp-group-header"><div><h2>${info.name}</h2><p>${detail}</p></div><span class="camp-total">${total}<span>人</span></span></header>`;
  }
  function roleSummary(config) {
    return `<div class="camp-summary">${['wolf', 'good'].map(camp => {
      const cards = ROLE_ORDER.filter(role => ROLES[role].camp === camp).map(role => {
        const count = config.roles[role];
        const included = count > 0;
        return `<div class="summary-item ${included ? 'is-included' : 'is-excluded'}" data-summary-role="${role}" aria-label="${ROLES[role].name}，${count} 人，${included ? '本局加入' : '未加入'}">
          <span class="role-presence">${included ? '✓ 本局加入' : '未加入'}</span>
          ${roleIcon(role, 'summary-icon')}<h3>${ROLES[role].name}</h3><div class="summary-count"><strong>${count}</strong><span>人</span></div>
        </div>`;
      }).join('');
      return `<section class="camp-group camp-${camp}" aria-label="${CAMP_PRESENTATION[camp].name}">${campHeader(config, camp)}<div class="summary-grid">${cards}</div></section>`;
    }).join('')}</div>`;
  }
  function rulesHTML() {
    return `<details class="rules-details"><summary>查看本版家規與使用提醒</summary><div class="rules-content">
      <p><strong>角色配置：</strong>5～18 人；普通狼人、狼王、惡靈騎士、村民、預言家、女巫、獵人、守衛、騎士。特殊角色各最多一名；狼人陣營、村民、神職各至少一名。可只有狼王或惡靈騎士、沒有普通狼人，不提供板子選擇。五人也用屠邊，不增加首夜免死或限次查驗。</p>
      <p><strong>夜間：</strong>守衛 → 狼人陣營 → 預言家 → 女巫。只排有配置的夜間角色。所有狼人陣營共用一刀，仍可選任一存活號碼；刀中惡靈騎士無效。預言家只查陣營，查惡靈顯示狼人；本局若有配置惡靈，預言家每晚也可選不查驗。入夜時存活的角色可以完成當晚操作，即使同晚死亡。</p>
      <p><strong>女巫：</strong>不可自救或自毒；解藥、毒藥各一次，同夜只能用一瓶。<strong>解藥尚在才能看狼刀；用完後連本人被刀也不顯示號碼。</strong>不透露守護目標。</p>
      <p><strong>守衛：</strong>可自守、可空守，不可連續兩晚守同一人；空守一晚後可重守。守護只影響當晚普通狼刀，同晚死亡不取消已確認守護。<strong>同守同救仍死亡</strong>，死者可依資格帶人；毒藥不能擋，含毒死因不能帶人。</p>
      <p><strong>騎士：</strong>整局決鬥一次，限存活且白天發言時使用，不限自己的發言輪。選到狼人陣營，目標死亡、取消投票，未終局就下一夜；選到好人，自己死亡、未終局則回白天。<strong>決鬥死者一律無遺言；被決鬥的狼王不能帶人。</strong></p>
      <p><strong>狼王：</strong>被狼刀、放逐、其他帶人技能、同守同救或自爆致死時可帶人；被毒或騎士決鬥不能帶人。狼人隊友只列號碼，不標出誰是狼王。</p>
      <p><strong>惡靈騎士／本版採用值：</strong>夜間免死，狼刀、毒藥及同守同救無效；參與共同狼刀但不可自爆。全局一次被動反傷，僅由預言家查驗或女巫下毒觸發，<strong>同晚驗毒只反傷女巫</strong>；毒藥仍消耗，反傷不可被守護或解藥阻擋。守護、解藥本身不觸發反傷。反傷用過後仍夜間免死。夜間全部結算後才公布死亡，不提示反傷或免疫是否發動，也不向本人顯示剩餘次數。</p>
      <p><strong>惡靈與白天技能：</strong>被投票放逐、騎士決鬥、獵人或狼王帶人，會正常出局，不反傷對方。<strong>本網站天亮後執行的帶人一律視為白天技能</strong>，包含原本在夜間死亡的獵人或狼王。惡靈本身沒有死亡帶人能力。</p>
      <p><strong>自爆：</strong>普通狼人與狼王皆可在白天發言時點自己的號碼自爆；自爆者沒有遺言，取消本日投票。<strong>狼王自爆可以帶人</strong>；未終局則完整處理可用技能與死亡流程後下一夜。進入投票／PK 就不能自爆或決鬥。</p>
      <p><strong>白天操作：</strong>號碼不標身份，各玩家只點自己。選擇後只需一次提交，不另外跳確認頁。先完成最終確認的合法動作先結算，不接受中途插入或追溯取消。自行投票與平票 PK，只輸入號碼或「沒有人出局」。沒有警長。</p>
      <p><strong>死亡技能：</strong>獵人被狼刀、放逐、帶人或同守同救致死可帶一名存活玩家，含毒死因不行。技能可放棄。公開介面只問「你要啟動技能嗎？」，不顯示身份或專屬圖示。</p>
      <p><strong>屠邊與 B 反擊規則：</strong>全部狼人陣營死亡，優先判好人勝；否則村民全滅或神職全滅，狼人勝。夜間效果同批結算。<strong>出現勝利條件但仍有獵人合法反擊時，跳過遺言、先反擊再判勝負。</strong>狼王沒有這項保障：最後狼王出局（含自爆）直接好人勝，不再帶人。</p>
      <p><strong>遺言：</strong>尚未終局的一般夜死、放逐及技能帶人有遺言；騎士決鬥與自爆者沒有。終局前反擊不安排遺言，結束後也不補。多人夜死按號碼順序處理。</p>
      <p><strong>操作時間：</strong>完成可立即結束；逾時只低頻閃紅催促，仍能選擇、返回與確認。已配置但已死亡的夜間角色保留等待時段，時間差仍可能成為推理線索。</p>
      <p><strong>資訊保護：</strong>私密身份、夜間目標與查驗結果不朗讀。切換 App 或暫停會遮蔽。沒有操作碼，網站不能驗證拿手機的人，禁止試點他人號碼；所有玩家仍須遵守閉眼規則。</p>
      <p><strong>存檔與語音：</strong>只在此網址、此瀏覽器儲存，不跨裝置同步。請只開一個主持分頁，避免無痕模式及清除網站資料。語音使用裝置提供的中文聲音，開局前先測試。沒有離線快取，請先連網開啟 GitHub Pages。本版沿用 V1.3 的規則與存檔。V1.2 及更早的舊局不相容。</p>
      <p><strong>V1.5 操作：</strong>夜間選人與死亡技能在同頁選擇後提交一次；女巫綠色十字瓶為解藥、紫色骷髏瓶為毒藥，確認前可改選，確認後不可撤銷。睜眼主持詞播完立即開放操作；每段閉眼主持詞播完，再留 3 秒緩衝後呼喚下一角色。文字模式讀完閉眼提示、按「已閉眼」後開始緩衝。開局查看身份仍須本人逐一確認。</p>
    </div></details>`;
  }

  function loadSettings() {
    try {
      const input = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (input && typeof input === 'object') {
        settings.audio = typeof input.audio === 'boolean' ? input.audio : true;
        settings.keepAwake = typeof input.keepAwake === 'boolean' ? input.keepAwake : true;
        settings.voiceURI = typeof input.voiceURI === 'string' ? input.voiceURI : '';
        settings.rate = [0.8, 0.92, 1, 1.1].includes(input.rate) ? input.rate : 0.92;
        settings.nightSeconds = [30, 45, 60, 90].includes(input.nightSeconds) ? input.nightSeconds : 45;
      }
    } catch (_) { saveIssue = '瀏覽器目前無法使用本機儲存。離開或重新整理後，進度可能遺失。'; }
    draft.nightSeconds = settings.nightSeconds;
  }
  function persistSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
    catch (_) { saveIssue = '設定無法儲存；目前仍可繼續使用，請避免重新整理。'; }
    renderNotice();
  }
  function readEnvelope() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const item = JSON.parse(raw);
      if (!item || !validGame(item.game)) {
        saveIssue = '存檔無法讀取，或不是相容的 V1.3／V1.4 存檔。請開始新遊戲；確認分配身份後才會覆蓋舊存檔。';
        return null;
      }
      return item;
    } catch (_) {
      saveIssue = '無法讀取本機存檔。請確認瀏覽器允許此網站儲存資料。';
      return null;
    }
  }
  function clockSnapshot() {
    if (!clock) return null;
    return { ...clock, remaining: clockEnd === null ? clock.remaining : Math.max(0, clockEnd - performance.now()) };
  }
  function saveGame() {
    if (!game || !active || foreignUpdate) return;
    try {
      const envelope = { schema: SCHEMA, writerId, savedAt: Date.now(), game, clock: clockSnapshot(), paused, pauseReason };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
      savedEnvelope = envelope;
      if (saveIssue && !saveIssue.includes('不相容')) saveIssue = '';
    } catch (_) {
      saveIssue = '自動存檔失敗。請勿重新整理或關閉分頁，否則可能遺失進度。';
    }
    renderNotice();
    renderFooter();
  }
  function cleanSavedClock(input) {
    if (!input || !['auto', 'slot', 'buffer'].includes(input.kind) || typeof input.key !== 'string' ||
      !Number.isFinite(input.remaining) || !Number.isFinite(input.total)) return null;
    if (input.total <= 0 || input.total > 120000 || input.remaining < 0 || input.remaining > 120000) return null;
    if (input.kind === 'buffer' && (input.total !== NIGHT_BUFFER_MS || input.remaining > NIGHT_BUFFER_MS)) return null;
    return { kind: input.kind, key: input.key, total: input.total, remaining: Math.min(input.total, input.remaining) };
  }

  class Voice {
    constructor() {
      this.supported = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
      this.voices = [];
      this.pending = null;
      this.watchdog = null;
      this.utterance = null;
      if (this.supported) {
        const update = () => { this.voices = window.speechSynthesis.getVoices(); updateVoiceOptions(); };
        this.voices = window.speechSynthesis.getVoices();
        window.speechSynthesis.addEventListener('voiceschanged', update);
      }
    }
    cancel() {
      clearTimeout(this.watchdog); this.watchdog = null;
      if (this.pending) { const finish = this.pending; this.pending = null; finish({ ok: false, reason: 'cancelled' }); }
      if (this.utterance) { this.utterance.onend = null; this.utterance.onerror = null; this.utterance = null; }
      if (this.supported) window.speechSynthesis.cancel();
    }
    speak(text, force = false) {
      this.cancel();
      if ((!settings.audio && !force) || !text) return Promise.resolve({ ok: true, reason: 'disabled' });
      if (!this.supported) return Promise.resolve({ ok: false, reason: 'unsupported' });
      return new Promise(resolve => {
        let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true;
          clearTimeout(this.watchdog); this.watchdog = null;
          this.pending = null;
          if (this.utterance) { this.utterance.onend = null; this.utterance.onerror = null; }
          this.utterance = null;
          resolve(result);
        };
        this.pending = finish;
        try {
          const voices = window.speechSynthesis.getVoices();
          const chosen = voices.find(v => v.voiceURI === settings.voiceURI) ||
            voices.find(v => /^zh[-_]TW$/i.test(v.lang)) || voices.find(v => /^zh/i.test(v.lang));
          const utterance = new window.SpeechSynthesisUtterance(text);
          this.utterance = utterance; // 保留參照，避免部分瀏覽器在播放中回收。
          utterance.lang = chosen?.lang || 'zh-TW';
          if (chosen) utterance.voice = chosen;
          utterance.rate = settings.rate; utterance.pitch = 1; utterance.volume = 1;
          utterance.onend = () => finish({ ok: true, reason: 'ended' });
          utterance.onerror = event => finish({ ok: false, reason: event.error || 'error' });
          this.watchdog = setTimeout(() => {
            finish({ ok: false, reason: 'timeout' });
            window.speechSynthesis.cancel();
          }, Math.min(30000, Math.max(10000, text.length * 500)));
          if (window.speechSynthesis.paused) window.speechSynthesis.resume();
          window.speechSynthesis.speak(utterance);
        } catch (_) { finish({ ok: false, reason: 'error' }); }
      });
    }
  }
  let voice = null;

  function corePublicPrompt(g) {
    if (!g) return '';
    const step = NIGHT_STEPS.find(s => s.wake === g.phase || s.sleep === g.phase);
    if (step) return g.phase === step.wake ? nightOpenText(g, step) : step.closeText;
    switch (g.phase) {
      case 'NIGHT_START': return '天黑請閉眼。請把手機放在桌面中央。';
      case 'DAWN': return '天亮了，所有玩家請睜眼。';
      case 'NIGHT_RESULT': {
        const ids = g.night.deaths.map(id => g.deathEvents.find(d => d.id === id).playerId);
        return ids.length ? `昨晚${ids.map(id => `${id}號`).join('、')}玩家死亡。` : '昨晚是平安夜。';
      }
      case 'LAST_WORDS': return `請${g.resolution.lastWordsQueue[0]}號玩家發表遺言。`;
      case 'DEATH_SKILL_SELECT':
      case 'DEATH_SKILL_DECISION': return `請${currentDeath(g).playerId}號玩家確認畫面。`;
      case 'DEATH_SKILL_RESULT': return `${g.resolution.lastSkillTarget}號玩家死亡。`;
      case 'DAY_DISCUSSION': return '現在進入白天發言。';
      case 'DAY_ACTION_RESULT': {
        const a = g.lastDayAction;
        return a.kind === 'self_destruct' ? `${a.actorId}號玩家自爆出局。本日取消投票。` :
          `${a.actorId}號向${a.targetId}號發動決鬥。${a.victimId}號玩家死亡。`;
      }
      case 'DAY_VOTE_RESULT': return '請輸入最終投票結果。';
      case 'DAY_EXECUTION': return `${g.vote.target}號玩家被放逐。`;
      case 'DAY_NO_EXECUTION': return '本輪沒有人出局。';
      case 'NEXT_NIGHT': return '白天結束。請把手機放回桌面中央，準備下一夜。';
      case 'GAME_OVER': {
        const wake = ''; // 夜間終局也必先經過 DAWN 的睜眼主持詞。
        const result = endingText(g);
        return `${wake}${result ? result + '。' : ''}遊戲結束，${g.winner.camp === 'good' ? '好人' : '狼人'}陣營獲勝。`;
      }
      default: return '';
    }
  }
  function publicPrompt(g) {
    if (!g) return '';
    const prefix = g.ui?.notice?.announceAt === pageKey(g) ? `${g.ui.notice.text}。` : '';
    return prefix + corePublicPrompt(g);
  }
  function safeReplayPrompt() {
    if (isSlotPhase(game)) return nightOpenText(game, activeStep(game));
    return publicPrompt(game);
  }
  function announceKey() {
    if (!game) return '';
    return `${pageKey(game)}:${game.ui?.notice?.announceAt === pageKey(game) ? game.ui.notice.text : ''}`;
  }
  function notifyVoiceFailure() {
    voiceIssue = '語音未成功播放。請檢查手機音量、選擇中文語音，或改用文字模式。';
    renderNotice();
  }
  function clearFlow() {
    clearTimeout(returnTimer); returnTimer = null;
    flowToken += 1;
    stopClock();
    autoKey = null;
    voice?.cancel();
  }
  function stopClock() {
    if (clock && clockEnd !== null) clock.remaining = Math.max(0, clockEnd - performance.now());
    clockEnd = null;
    if (intervalId !== null) clearInterval(intervalId);
    intervalId = null;
  }
  function setClock(kind, key, ms) {
    stopClock();
    clock = { kind, key, total: ms, remaining: ms };
  }
  function runClock() {
    if (!active || paused || foreignUpdate || !clock || intervalId !== null) return;
    if (clock.remaining <= 0) {
      if (clock.kind === 'slot' && !game.night.completed[game.night.activeRole]) { updateTimerDOM(0); return; }
      expireClock(); return;
    }
    clockEnd = performance.now() + clock.remaining;
    lastCheckpoint = performance.now();
    updateTimerDOM();
    intervalId = setInterval(() => {
      if (!clock || clockEnd === null) return;
      const remaining = Math.max(0, clockEnd - performance.now());
      updateTimerDOM(remaining);
      if (performance.now() - lastCheckpoint >= 1000) {
        saveGame(); lastCheckpoint = performance.now();
      }
      if (remaining <= 0) {
        expireClock();
      }
    }, 100);
  }
  function expireClock() {
    if (!clock) return;
    const kind = clock.kind;
    stopClock();
    clock.remaining = 0;
    if (kind === 'auto' || kind === 'buffer') { clock = null; autoKey = null; dispatch({ type: 'AUTO' }); }
    else if (game.night.completed[game.night.activeRole]) {
      // 僅供已死亡行動者的等待時段；存活角色在完成時已直接進入閉眼頁。
      clock = null; dispatch({ type: 'FINISH_SLOT' });
    } else {
      updateTimerDOM(0);
      saveGame(); // 保留在原畫面與選擇，不自動確認，也不播出私密資料。
    }
  }
  function updateTimerDOM(value) {
    const snap = clockSnapshot();
    const remaining = value ?? snap?.remaining ?? 0;
    const overdue = !!(snap?.kind === 'slot' && active && view === 'game' && !paused &&
      !foreignUpdate && isSlotPhase(game) && !game.night.completed[game.night.activeRole] && remaining <= 0);
    document.body.classList.toggle('slot-overdue', overdue);
    const warning = document.getElementById('overtime-warning');
    if (warning) warning.hidden = !overdue;
    if (!snap) return;
    const text = document.getElementById('timer-number');
    const fill = document.getElementById('timer-fill');
    const bufferNumber = document.getElementById('buffer-number');
    const bufferFill = document.getElementById('buffer-fill');
    if (text) text.textContent = overdue ? '已逾時' : `${Math.ceil(remaining / 1000)} 秒`;
    if (fill) fill.style.transform = `scaleX(${Math.min(1, Math.max(0, remaining / snap.total))})`;
    if (bufferNumber && isNightBuffer(game, snap)) bufferNumber.textContent = String(Math.ceil(remaining / 1000));
    if (bufferFill && isNightBuffer(game, snap)) bufferFill.style.transform = `scaleX(${Math.max(0, remaining / snap.total)})`;
  }

  function beginNightBuffer() {
    if (!game || !active || paused || foreignUpdate || !isNightClosing(game)) return;
    if (isNightBuffer(game, clock)) return; // 防重複點擊，不延長／重開同一段計時。
    setClock('buffer', nightBufferKey(game), NIGHT_BUFFER_MS);
    autoKey = `auto:${game.round}:${game.phase}`;
    render();
    runClock();
    saveGame();
  }
  function continueTextCue() {
    if (!game || !active || paused || foreignUpdate || settings.audio || !AUTO_PHASES.has(game.phase)) return;
    if (isNightClosing(game)) beginNightBuffer();
    else dispatch({ type: 'AUTO' });
  }
  function ensureFlow() {
    if (!game || !active || paused || foreignUpdate) return;
    if (AUTO_PHASES.has(game.phase)) {
      const key = `auto:${game.round}:${game.phase}`;
      if (autoKey === key) return;
      autoKey = key;
      // 已播完閉眼的緩衝可暫停／還原：續跑剩餘時間，不重播也不重置三秒。
      if (isNightBuffer(game, clock)) { runClock(); return; }
      stopClock(); clock = null;
      const token = ++flowToken;
      const current = () => token === flowToken && active && !paused && !foreignUpdate;
      if (game.phase === 'NIGHT_RESOLVE') {
        Promise.resolve().then(() => { if (current()) dispatch({ type: 'AUTO' }); });
        return;
      }
      // 文字模式由現場讀完提示，再按一次繼續／已閉眼；不跳過閉眼緩衝。
      if (!settings.audio) return;
      voice.speak(publicPrompt(game)).then(result => {
        if (!current()) return;
        if (!result.ok) {
          if (result.reason !== 'cancelled') { notifyVoiceFailure(); pauseGame('audio'); }
          return;
        }
        if (isNightClosing(game)) beginNightBuffer();
        else dispatch({ type: 'AUTO' }); // 睜眼：onend 後立即開放，不另加三秒。
      });
    } else if (isSlotPhase(game)) {
      autoKey = null;
      const key = `slot:${game.round}:${game.night.activeRole}`;
      if (!clock || clock.key !== key) setClock('slot', key, game.config.nightSeconds * 1000);
      runClock();
    } else {
      if (clock) { stopClock(); clock = null; }
      autoKey = null;
      if (game.phase === 'DAY_ACTION_UNAVAILABLE') {
        if (returnTimer !== null) return;
        const token = flowToken;
        returnTimer = setTimeout(() => {
          returnTimer = null;
          if (token === flowToken && active && !paused && !foreignUpdate && game.phase === 'DAY_ACTION_UNAVAILABLE') {
            dispatch({ type: 'CANCEL_DAY_ACTION' });
          }
        }, 1400);
        return;
      }
      const key = announceKey();
      const text = publicPrompt(game);
      if (text && lastAnnounced !== key) {
        lastAnnounced = key;
        const token = flowToken;
        voice.speak(text).then(result => {
          if (token !== flowToken || paused || !active) return;
          if (!result.ok && result.reason !== 'cancelled') notifyVoiceFailure();
        });
      }
    }
  }

  async function requestWakeLock() {
    if (!settings.keepAwake || !active || paused || document.visibilityState !== 'visible' ||
      !('wakeLock' in navigator) || wakeLock || wakePending || wakeFailed) return;
    wakePending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!active || paused || !settings.keepAwake || document.visibilityState !== 'visible') {
        await lock.release();
      } else {
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; renderFooter(); });
      }
    } catch (_) { wakeFailed = true; }
    finally { wakePending = false; renderFooter(); }
  }
  function releaseWakeLock() {
    if (wakeLock) { const lock = wakeLock; wakeLock = null; lock.release().catch(() => {}); }
  }
  function pauseGame(reason = 'manual', shouldSave = true) {
    if (!game || !active) return;
    paused = true; pauseReason = reason;
    clearFlow(); releaseWakeLock();
    if (dialog.open) dialog.close();
    if (shouldSave) saveGame();
    render();
  }
  function resumeGame(textOnly = false) {
    if (foreignUpdate) return;
    if (textOnly) { settings.audio = false; voiceIssue = ''; persistSettings(); }
    paused = false; pauseReason = ''; autoKey = null; lastAnnounced = '';
    wakeFailed = false;
    render(); ensureFlow(); saveGame(); requestWakeLock();
  }

  function renderNotice() {
    const el = document.getElementById('persistent-notice');
    const message = [saveIssue, voiceIssue].filter(Boolean).join(' ');
    el.hidden = !message; el.textContent = message;
  }
  function renderFooter() {
    if (!footer) return;
    const save = active && game ? (saveIssue ? '存檔不可用' : '本機自動存檔') : '一支手機，一起入夜。';
    const awake = active && settings.keepAwake ? (wakeLock ? ' · 保持亮屏' : ' · 請留意鎖屏') : '';
    footer.innerHTML = `<span class="status-save">${active ? '<span class="status-dot"></span>' : ''}${save}${awake}</span><span>V${VERSION}</span>`;
  }
  function toast(message) {
    const el = document.getElementById('toast');
    clearTimeout(toastId); el.textContent = message; el.hidden = false;
    toastId = setTimeout(() => { el.hidden = true; }, 4800);
  }
  function showDialog(title, message, onConfirm, confirmLabel = '確認', danger = false) {
    lastFocus = document.activeElement;
    dialogCallback = onConfirm;
    dialog.innerHTML = `<h2 id="dialog-title">${esc(title)}</h2><p>${esc(message)}</p><div class="actions two">${btn('取消', 'DIALOG_CANCEL', 'secondary')}${btn(esc(confirmLabel), 'DIALOG_CONFIRM', danger ? 'danger' : 'primary')}</div>`;
    dialog.showModal();
    dialog.querySelector('[data-action="DIALOG_CANCEL"]').focus();
  }
  function closeDialog() {
    if (dialog.open) dialog.close();
    dialogCallback = null;
    if (lastFocus?.isConnected) lastFocus.focus();
  }
  function updateVoiceOptions() {
    const select = document.getElementById('voice-select');
    if (!select || !voice) return;
    const voices = voice.voices.filter(v => /^zh/i.test(v.lang));
    select.innerHTML = `<option value="">自動選擇中文語音</option>` + voices.map(v =>
      `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.voiceURI ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
    const status = document.getElementById('voice-status');
    if (status) status.textContent = !voice.supported ? '目前瀏覽器不支援語音，可使用文字模式。' :
      voices.length ? `裝置提供 ${voices.length} 種中文語音，播放前請確認音量。` : '尚未列出中文語音；可先測試自動選擇，或改用文字模式。';
  }

  /* ── 畫面：一個 HTML 容器切換狀態，不建立多個實體頁面 ── */
  function audioSettingsHTML(showTiming = true) {
    return `<div class="settings-grid">
      <div class="setting-row"><div><label id="audio-label">語音主持</label><small>只朗讀公開主持詞</small></div>
        <button type="button" class="toggle" role="switch" aria-labelledby="audio-label" aria-checked="${settings.audio}" data-action="TOGGLE_AUDIO"></button></div>
      <div><label for="voice-select" class="small">中文語音</label><select id="voice-select" class="voice-picker" data-setting="voiceURI"><option>自動選擇中文語音</option></select><p id="voice-status" class="tiny muted no-margin"></p></div>
      <div class="setting-row"><label for="rate-select">語速</label><select id="rate-select" data-setting="rate">${[[0.8, '較慢'], [0.92, '稍慢（建議）'], [1, '一般'], [1.1, '稍快']].map(([v, t]) => `<option value="${v}" ${settings.rate === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      ${btn(`${icons.audio} 測試主持語音`, 'TEST_VOICE', 'secondary')}
      ${showTiming ? `<div class="setting-row"><div><label for="duration-select">每個角色催促倒數</label><small>完成即可提前結束；時間到只閃紅催促</small></div><select id="duration-select" data-setting="nightSeconds">${[30, 45, 60, 90].map(n => `<option value="${n}" ${draft.nightSeconds === n ? 'selected' : ''}>${n} 秒</option>`).join('')}</select></div>` : ''}
      <div class="setting-row"><div><label id="awake-label">盡量保持螢幕亮起</label><small>依瀏覽器、電量與系統設定而定</small></div><button type="button" class="toggle" role="switch" aria-labelledby="awake-label" aria-checked="${settings.keepAwake}" data-action="TOGGLE_AWAKE"></button></div>
    </div>`;
  }
  function renderHome() {
    const stored = savedEnvelope?.game;
    const resume = stored ? `<div class="resume-card"><div class="resume-text"><strong>${stored.status === 'finished' ? '上一局已結束' : '有一局尚未結束'}</strong><p>${stored.round ? `第 ${stored.round} 回合` : '身份分配階段'} · ${stored.config.playerCount} 人</p></div></div>` : '';
    return `<div class="page"><section class="panel home-panel">
      <div class="home-top"><div><span class="eyebrow">WEREWOLF / V1.5</span><h1 class="home-title title-serif">狼人殺<br>自動法官</h1></div><div class="moon-art" aria-hidden="true"><span class="moon"></span></div></div>
      <p class="home-copy">九種角色，5～18 人自訂配置。<br>一支手機，完成發牌、主持與結算。</p>
      ${resume}<div class="actions">${stored ? btn(stored.status === 'finished' ? '查看上一局結果' : '繼續上次遊戲', 'LOAD_GAME') : ''}${btn(`開始新遊戲 ${icons.arrow}`, 'NEW_GAME', stored ? 'secondary' : 'primary')}</div>
      <div class="home-features"><div class="feature"><strong>一機輪流</strong>不用實體身份牌</div><div class="feature"><strong>語音帶局</strong>夜間流程自動推進</div><div class="feature"><strong>自動結算</strong>記錄死亡與勝負</div></div>
    </section>${rulesHTML()}</div>`;
  }
  function evilRulesNote() {
    return note('<strong>惡靈騎士：本版採用規則</strong><br>夜間免死 · 不可自爆 · 一次被動反傷<br>同晚驗毒只反女巫；守護、解藥不觸發，也不能阻止反傷。<br>天亮後的放逐、決鬥與帶人可使其出局；預言家可選不查驗。');
  }
  function renderSetupCount() {
    return panel(`${stepTrack(1)}${heading('今晚幾個人？', '座位依序編成 1 號到最後一號，全員參與遊戲。', '01 / 建立遊戲')}
      <div class="player-counter"><button type="button" class="counter-button" data-action="COUNT" data-delta="-1" aria-label="減少一名玩家" ${draft.playerCount <= MIN_PLAYERS ? 'disabled' : ''}>−</button><div class="counter-number">${draft.playerCount}</div><button type="button" class="counter-button" data-action="COUNT" data-delta="1" aria-label="增加一名玩家" ${draft.playerCount >= MAX_PLAYERS ? 'disabled' : ''}>＋</button></div>
      <p class="center small muted">可設定 ${MIN_PLAYERS}～${MAX_PLAYERS} 人</p>
      <div class="presets">${[5, 6, 8, 9, 10, 12].map(n => `<button type="button" class="chip ${n === draft.playerCount ? 'selected' : ''}" data-action="PRESET_COUNT" data-id="${n}">${n} 人</button>`).join('')}</div>
      ${note('請先坐好並記住自己的號碼。身份確認後，整局使用同一個座位號碼。')}
      <div class="actions two">${btn('回首頁', 'HOME', 'secondary')}${btn('設定角色', 'SETUP_ROLES')}</div>`);
  }
  function renderSetupRoles() {
    const errors = configErrors(draft);
    const groups = ['wolf', 'good'].map(camp => {
      const rows = ROLE_ORDER.filter(role => ROLES[role].camp === camp).map(role => {
        const r = ROLES[role];
        const included = draft.roles[role] > 0;
        const controls = r.max === 1
          ? `<button type="button" class="toggle" role="switch" aria-label="加入${r.name}" aria-checked="${draft.roles[role] === 1}" data-action="TOGGLE_ROLE" data-role="${role}"></button>`
          : `<div class="role-controls"><button type="button" data-action="ROLE_COUNT" data-role="${role}" data-delta="-1" aria-label="減少${r.name}" ${draft.roles[role] <= (role === 'wolf' ? 0 : 1) ? 'disabled' : ''}>−</button><span class="role-count">${draft.roles[role]}</span><button type="button" data-action="ROLE_COUNT" data-role="${role}" data-delta="1" aria-label="增加${r.name}" ${draft.roles[role] >= draft.playerCount ? 'disabled' : ''}>＋</button></div>`;
        return `<div class="role-row ${included ? 'is-included' : 'is-excluded'}" data-config-role="${role}"><span class="role-seal" aria-hidden="true">${roleIcon(role)}</span><div class="role-info"><div class="role-name-line"><strong>${r.name}</strong><span class="row-presence">${included ? '已加入' : '未加入'}</span></div><small>${r.summary}</small></div>${controls}</div>`;
      }).join('');
      return `<section class="camp-group role-config-group camp-${camp}" aria-label="${CAMP_PRESENTATION[camp].name}">${campHeader(draft, camp)}<div class="camp-role-rows">${rows}</div></section>`;
    }).join('');
    return panel(`${stepTrack(2)}${heading('分配角色數量', '先設定牌組；下一步才會隨機發給玩家。', '02 / 角色配置')}
      <div class="camp-config">${groups}</div><div class="config-count"><span>已配置角色</span><strong>${totalConfigured()} / ${draft.playerCount}</strong></div>
      ${errors.length ? note(errors.map(esc).join('<br>'), 'warning') : note('配置完成。特殊角色各 0 或 1 名；普通狼人可為 0，只要狼人陣營合計至少一名即可。')}
      ${draft.playerCount === 5 ? note('五人仍採屠邊，第一夜起正常行動；本配置未經勝率平衡驗證，反傷可能讓遊戲快速結束。') : ''}
      ${draft.roles.evilknight ? evilRulesNote() : ''}
      <div class="center"><button type="button" class="text-button" data-action="RECOMMEND_ROLES">依人數重新配置</button></div>
      <div class="actions two">${btn('上一步', 'SETUP_COUNT', 'secondary')}${btn('確認設定', 'SETUP_CONFIRM', 'primary', errors.length ? 'disabled' : '')}</div>`);
  }

  function renderSetupConfirm() {
    return `<div class="page"><section class="panel">${stepTrack(3)}${heading(`${draft.playerCount} 人局，準備入夜`, '請確認角色與主持設定，再開始秘密發牌。', '03 / 確認設定')}
      ${roleSummary(draft)}${note('<strong>本版固定家規</strong><br>屠邊勝負 · 女巫不可自救 · 同守同救死亡<br>獵人保有合法反擊 · 狼王自爆可帶人<br>解藥用完不看刀 · 決鬥、自爆者無遺言')}
      ${draft.roles.evilknight ? evilRulesNote() : ''}
      <hr class="divider"><h2>主持設定</h2>${audioSettingsHTML(true)}
      ${savedEnvelope?.game.status !== 'finished' && savedEnvelope ? note('按下「分配身份」會覆蓋尚未結束的上一局。', 'warning') : ''}
      <div class="actions two">${btn('修改角色', 'SETUP_ROLES', 'secondary')}${btn('分配身份', 'DEAL')}</div>
    </section>${rulesHTML()}</div>`;
  }
  function renderPause() {
    let title = '遊戲已暫停';
    let description = '畫面已遮蔽。請由剛才操作的玩家拿回手機。';
    if (pauseReason === 'resume') { title = '準備繼續本局'; description = '進度已讀取，身份與操作畫面尚未顯示。'; }
    if (pauseReason === 'hidden') description = '離開畫面時已停止流程。請由剛才操作的玩家拿回手機。';
    if (pauseReason === 'audio') { title = '語音尚未完成'; description = '流程已停住。請確認音量與中文語音設定，再重試；也可改用文字模式。'; }
    if (foreignUpdate) {
      title = '另一個分頁更新了遊戲';
      description = '此分頁已停止寫入。請先關閉其他主持分頁，再載入最新進度，避免同時操作。';
    }
    return panel(`${symbol('lock')}${heading(title, '', 'PAUSED / 畫面已遮蔽', true)}
      <p class="muted pause-privacy">${description}</p>
      ${note('若目前為夜間，請先確認其他玩家都已閉眼。只有原操作玩家可以繼續查看。')}
      <div class="actions">${foreignUpdate ? btn('載入最新進度', 'RELOAD_LATEST') : btn(pauseReason === 'audio' ? '重試語音並繼續' : '由原操作玩家繼續', 'RESUME')}
        ${pauseReason === 'audio' ? btn('改用文字模式繼續', 'RESUME_TEXT', 'secondary') : ''}</div>
      ${!foreignUpdate ? `<details class="rules-details"><summary>語音與螢幕設定</summary><div class="rules-content">${audioSettingsHTML(false)}</div></details>${rulesHTML()}<div class="center"><button type="button" class="text-button" data-action="ABANDON">放棄並清除此局</button></div>` : ''}`, 'center');
  }
  function progressDots() {
    return `<div class="progress-dots" aria-label="已確認 ${game.players.filter(p => p.roleViewed).length} 位身份">${game.players.map(p => `<span class="${p.roleViewed ? 'done' : ''}"></span>`).join('')}</div>`;
  }
  function ribbon() {
    const role = game.night.activeRole;
    const snapshot = clock?.kind === 'slot' ? clockSnapshot() : { remaining: game.config.nightSeconds * 1000 };
    return `<div class="phase-ribbon play-ribbon"><span class="phase-role">${roleIcon(role, 'mini-icon')}第 ${game.round} 夜 · ${activeStep(game).label}</span><span class="timer-number" id="timer-number">${Math.ceil(snapshot.remaining / 1000)} 秒</span></div><div class="timer-track play-timer-track" aria-hidden="true"><div class="timer-fill" id="timer-fill"></div></div>`;
  }
  function publicNoticeHTML() {
    const n = game.ui?.notice;
    return n ? `<div class="public-result-strip">${esc(n.text)}</div>` : '';
  }
  function playPage(content, actions = '', cls = '') {
    return `<div class="page play-page"><section class="panel play-panel ${cls}">${content}</section>${actions ? `<div class="action-dock">${actions}</div>` : ''}</div>`;
  }
  function playHeading(title, detail = '', actorId = null) {
    const phase = isNight(game) ? ribbon() : `<div class="play-phase-label">第 ${game.round} 天${actorId !== null ? ` · ${actorId} 號玩家` : ''}</div>`;
    return `${phase}<div class="play-heading"><h1>${title}</h1>${detail ? `<p>${detail}</p>` : ''}</div>`;
  }
  function grid() {
    const allowed = eligibleTargets(game);
    return `<div class="players-grid play-grid" data-player-count="${game.players.length}" role="group" aria-label="玩家號碼">${game.players.map(p => {
      const disabled = !allowed.includes(p.id);
      const selected = p.id === game.selected && !game.ui?.alternative;
      return `<button type="button" class="player-button ${selected ? 'selected' : ''} ${p.alive ? '' : 'dead'}" data-action="UI_SELECT" data-id="${p.id}" aria-label="${p.id} 號${!p.alive ? '，已出局' : disabled ? '，不可選' : ''}" aria-pressed="${selected}" ${disabled ? 'disabled' : ''}><span class="number">${p.id}</span>${!p.alive ? '<span class="dead-mark" aria-hidden="true">×</span>' : ''}</button>`;
    }).join('')}</div>`;
  }
  function discussionGrid() {
    return `<div class="players-grid play-grid discussion-grid" data-player-count="${game.players.length}" role="group" aria-label="玩家號碼，請只點自己的號碼">${game.players.map(p =>
      `<button type="button" class="player-button ${p.alive ? '' : 'dead'}" data-action="OPEN_DAY_ACTION" data-id="${p.id}" aria-label="${p.id} 號玩家${p.alive ? '' : '，已出局'}" ${p.alive ? '' : 'disabled'}><span class="number">${p.id}</span>${!p.alive ? '<span class="dead-mark" aria-hidden="true">×</span>' : ''}</button>`
    ).join('')}</div>`;
  }
  function choiceButton(label, action, selected, extra = '') {
    return btn(label, action, `secondary choice-option ${selected ? 'selected' : ''}`, `aria-pressed="${selected}" ${extra}`);
  }
  function selectionPage(title, detail = '') {
    let label = '請先選擇號碼', extra = '', actorId = null;
    const selected = game.selected;
    const alt = game.ui?.alternative === 'pass';
    switch (game.phase) {
      case 'GUARD_SELECT': {
        const actor = roleActor(game, 'guard');
        const last = actor.skills.lastGuardRound === game.round - 1 ? actor.skills.lastGuardTarget : null;
        detail = last !== null ? `上晚守 ${last} 號，本晚不可連守` : '';
        label = selected === 0 ? '確定今晚不守護' : selected !== null ? `確定守護 ${selected} 號` : label;
        extra = choiceButton('今晚不守護', 'UI_SELECT', selected === 0, 'data-id="0"');
        break;
      }
      case 'WOLF_SELECT': label = selected !== null ? `確定襲擊 ${selected} 號` : label; break;
      case 'SEER_SELECT':
        label = alt ? '確定今晚不查驗' : selected !== null ? `查驗 ${selected} 號` : label;
        if (maySkipSeer(game)) extra = choiceButton('今晚不查驗', 'UI_ALTERNATIVE', alt);
        break;
      case 'DEATH_SKILL_SELECT':
        actorId = currentDeath(game).playerId;
        label = alt ? '確定不啟動' : selected !== null ? `確定帶走 ${selected} 號` : '選擇目標或不啟動';
        extra = choiceButton('不啟動', 'UI_ALTERNATIVE', alt);
        break;
      case 'KNIGHT_SELECT':
        actorId = game.dayAction.actorId;
        label = selected !== null ? `確定與 ${selected} 號決鬥` : label;
        break;
      case 'DAY_VOTE_RESULT':
        label = selected === 0 ? '確定沒有人出局' : selected !== null ? `確定放逐 ${selected} 號` : label;
        extra = choiceButton('沒有人出局', 'UI_SELECT', selected === 0, 'data-id="0"');
        break;
    }
    const ready = selected !== null || alt;
    const actions = btn(label, 'UI_COMMIT', 'primary', ready ? '' : 'disabled') +
      (game.phase === 'KNIGHT_SELECT' ? btn('返回發言', 'CANCEL_DAY_ACTION', 'secondary') : '');
    return playPage(`${!isNight(game) ? publicNoticeHTML() : ''}${playHeading(title, detail, actorId)}${grid()}${extra}`, actions);
  }
  function potionIcon(kind) {
    // 形狀與文字皆可辨識：寬圓瓶＋十字／窄方瓶＋骷髏，不只依靠綠紫配色。
    const art = kind === 'heal'
      ? '<path d="M21 7h22v9H21zM24 16v7c-10 4-14 11-14 21 0 9 7 13 22 13s22-4 22-13c0-10-4-17-14-21v-7"/><path d="M27 31h10v7h7v10h-7v7H27v-7h-7V38h7z"/>'
      : '<path d="M24 5h16v12H24zM24 17l-9 10v30h34V27L40 17"/><path d="M32 28c-9 0-13 5-13 11 0 5 4 8 8 9v6h10v-6c4-1 8-4 8-9 0-6-4-11-13-11Z"/><circle cx="27" cy="38" r="2"/><circle cx="37" cy="38" r="2"/><path d="m30 44 2-3 2 3M30 49v5m4-5v5"/>';
    return `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${art}</svg>`;
  }
  function renderWitch() {
    const witch = roleActor(game, 'witch');
    const healRemaining = witch.skills.heal > 0;
    // 未持有解藥時，連 data 屬性、可及名稱都不寫入狼刀號碼。
    const target = healRemaining ? game.night.wolfTarget : null;
    const canHeal = healRemaining && target !== null && target !== witch.id;
    const canPoison = witch.skills.poison > 0;
    const action = game.ui?.witchAction;
    const selected = game.selected;
    const healDetail = !healRemaining ? '已用完' : target === witch.id ? '不可自救' : target === null ? '本晚無可救對象' : `救 ${target} 號`;
    const poisonDetail = canPoison ? '選擇毒殺對象' : '已用完';
    const cards = `<div class="potion-actions" role="group" aria-label="本晚用藥">
      <button type="button" class="potion-action heal ${action === 'heal' ? 'chosen' : ''}" data-action="UI_WITCH_CHOICE" data-choice="heal" aria-pressed="${action === 'heal'}" ${canHeal ? '' : 'disabled'}>
        <span class="potion-art">${potionIcon('heal')}</span><span class="potion-label"><strong>解藥・救人</strong><span>${healDetail}</span></span><span class="potion-check" aria-hidden="true">${action === 'heal' ? '✓' : ''}</span>
      </button>
      <button type="button" class="potion-action poison ${action === 'poison' ? 'chosen' : ''}" data-action="UI_WITCH_CHOICE" data-choice="poison" aria-pressed="${action === 'poison'}" ${canPoison ? '' : 'disabled'}>
        <span class="potion-art">${potionIcon('poison')}</span><span class="potion-label"><strong>毒藥・毒人</strong><span>${poisonDetail}</span></span><span class="potion-check" aria-hidden="true">${action === 'poison' ? '✓' : ''}</span>
      </button>
    </div>`;
    let label = '請選擇本晚行動';
    let ready = false;
    if (action === 'heal' && canHeal) { label = `使用解藥救 ${target} 號`; ready = true; }
    if (action === 'poison') { label = selected !== null ? `使用毒藥毒 ${selected} 號` : '請選擇毒殺對象'; ready = selected !== null && canPoison; }
    if (action === 'pass') { label = '確定今晚不用藥'; ready = true; }
    const bothEmpty = !healRemaining && !canPoison;
    const title = healRemaining && target !== null ? `今晚被刀：${target} 號` : '本晚用藥';
    const poisonGrid = action === 'poison' ? `<section class="poison-targets" aria-label="毒殺對象"><h2>${potionIcon('poison')}毒殺對象</h2>${grid()}</section>` : '';
    const skip = !bothEmpty ? choiceButton('今晚不用藥', 'UI_WITCH_CHOICE', action === 'pass', 'data-choice="pass"') : '';
    const controls = bothEmpty ? btn('結束操作', 'ACK_WITCH') : btn(label, 'UI_COMMIT', action === 'heal' ? 'commit-heal' : action === 'poison' ? 'commit-poison' : 'primary', ready ? '' : 'disabled');
    return playPage(`${playHeading(title)}${cards}${poisonGrid}${skip}`, controls, 'witch-panel');
  }
  function autoPage() {
    const opening = NIGHT_STEPS.find(s => s.wake === game.phase);
    const closing = NIGHT_STEPS.find(s => s.sleep === game.phase);
    let title = '', kind = 'moon';
    if (game.phase === 'NIGHT_START') title = '天黑請閉眼';
    if (opening) title = `${opening.label}請睜眼`;
    if (closing) title = `${closing.label}請閉眼`;
    if (game.phase === 'NIGHT_RESOLVE') title = '請保持閉眼';
    if (game.phase === 'DAWN') { title = '天亮請睜眼'; kind = 'sun'; }
    const buffering = isNightBuffer(game, clock);
    const snap = buffering ? clockSnapshot() : null;
    const seconds = snap ? Math.ceil(snap.remaining / 1000) : NIGHT_BUFFER_MS / 1000;
    const buffer = buffering ? `<div class="night-buffer"><p>交接緩衝</p><div class="buffer-count"><span id="buffer-number">${seconds}</span><span>秒</span></div><div class="buffer-track" aria-hidden="true"><div id="buffer-fill"></div></div></div>` : '';
    const manual = !settings.audio && game.phase !== 'NIGHT_RESOLVE' && !buffering;
    const controls = manual ? btn(closing ? '已閉眼' : '繼續', 'CUE_CONTINUE') : '';
    return playPage(`<div class="play-phase-label">第 ${game.round} ${kind === 'sun' ? '天' : '夜'}</div>${symbol(kind)}<h1 class="cue-title">${title}</h1>${buffer}${manual ? '<p class="cue-hint">讀出提示後繼續</p>' : ''}`, controls, 'center cue-panel');
  }

  function renderGame() {
    if (AUTO_PHASES.has(game.phase)) return autoPage();
    switch (game.phase) {
      case 'ROLE_HANDOFF': {
        const p = game.players[game.revealIndex];
        return panel(`<div class="privacy-label">${icons.lock} 私密身份</div><p class="muted no-margin">請將手機交給</p><div class="big-player">${p.id}<small>號玩家</small></div><h2>其他玩家請勿觀看</h2><p class="muted small">拿穩手機、避開旁人視線，再打開身份。</p><div class="actions">${btn(`我是 ${p.id} 號，查看身份`, 'REVEAL')}</div>${progressDots()}<p class="tiny muted no-margin">第 ${game.revealIndex + 1} 位，共 ${game.players.length} 位</p>`, 'center');
      }
      case 'ROLE_REVEAL': {
        const p = game.players[game.revealIndex], r = ROLES[p.role];
        const teammates = game.players.filter(x => x.camp === 'wolf' && x.id !== p.id);
        const camp = CAMP_PRESENTATION[p.camp];
        const category = r.category === 'god' ? '神職' : r.category === 'villager' ? '村民' : null;
        return panel(`<div class="privacy-label">${icons.lock} ${p.id} 號玩家專屬</div>
          <div class="identity-card camp-${p.camp}">
            <div class="identity-camp-banner"><strong>${camp.headline}</strong><span>${camp.name}</span></div>
            ${roleIcon(p.role, 'identity-icon')}<h1>${r.name}</h1>
            ${category ? `<span class="identity-category">${category}</span>` : ''}
            <p class="identity-goal">${camp.goal}</p>
            ${p.camp === 'wolf' ? `<div class="teammates"><span>你的狼人隊友</span><br><strong>${teammates.length ? teammates.map(x => `${x.id} 號`).join('、') : '本局沒有其他狼人隊友'}</strong></div>` : ''}
          </div>
          <p class="identity-description">${r.description}</p><div class="actions">${btn('我記住了，隱藏身份', 'REMEMBER')}</div><p class="tiny muted gap-top no-margin">身份不會朗讀，也不能返回上一位。</p>`, 'center private-role-panel');
      }
      case 'ROLE_COMPLETE':
        return panel(`${symbol('check')}${heading('所有身份已確認', '請把手機放到桌面中央。', '準備開始', true)}
          ${note(`本局夜間順序：<strong>${configuredNightSteps(game).map(s => s.label).join(' → ')}</strong>。<br>每個角色倒數 <strong>${game.config.nightSeconds} 秒</strong> 作為催促；完成即可結束，逾時只閃紅提醒，仍可操作。`)}
          <div class="actions">${btn(`${icons.audio} 測試主持語音`, 'TEST_VOICE', 'secondary')}${btn(settings.audio ? '啟用語音並開始遊戲' : '以文字模式開始遊戲', 'START')}</div>
          <div class="center"><button type="button" class="text-button" data-action="TOGGLE_AUDIO">${settings.audio ? '改用文字模式' : '改用語音模式'}</button></div>
          <p class="tiny muted no-margin">文字模式需有人讀出畫面指示。請先確認每位玩家聽得見語音。</p>`, 'center');
      case 'GUARD_SELECT': return selectionPage('今晚守護誰？');
      case 'WOLF_SELECT': return selectionPage('今晚襲擊誰？');
      case 'SEER_SELECT': return selectionPage('今晚查驗誰？');
      case 'SEER_RESULT':
        return playPage(`${ribbon()}<div class="big-player">${game.night.seerTarget}<small>號</small></div><div class="result-emblem">${game.night.seerResult === 'wolf' ? '狼人' : '好人'}</div>`, btn('看完', 'ACK_SEER'), 'center seer-result-panel');
      case 'WITCH_HEAL': case 'WITCH_POISON': case 'WITCH_DONE': return renderWitch();
      case 'NIGHT_WAIT':
        return playPage(`${ribbon()}${symbol('moon')}<h1 class="cue-title">請保持閉眼</h1>`, '', 'center cue-panel');
      case 'LAST_WORDS': {
        const list = game.resolution.lastWordsQueue;
        return playPage(`${publicNoticeHTML()}<div class="play-phase-label">第 ${game.round} 天 · 遺言</div><div class="big-player">${list[0]}<small>號玩家</small></div><h1>請發表遺言</h1>${list.length > 1 ? `<p class="words-next">下一位：${list.slice(1).map(id => `${id} 號`).join('、')}</p>` : ''}`, btn('遺言結束', 'ACK_WORDS'), 'center words-panel');
      }
      case 'DEATH_SKILL_SELECT': return selectionPage('你要啟動技能嗎？', '選擇要帶走的玩家');
      case 'DAY_DISCUSSION':
        return playPage(`${publicNoticeHTML()}${playHeading('白天發言')}${discussionGrid()}`, btn('進入投票', 'VOTE'));
      case 'DAY_ACTION_UNAVAILABLE':
        return playPage(`<div class="play-phase-label">${game.dayAction.actorId} 號玩家</div>${symbol('star', true)}<h1>目前無可用技能</h1>`, '', 'center cue-panel');
      case 'KNIGHT_SELECT': return selectionPage('你要啟動技能嗎？', '選擇決鬥對象');
      case 'SELF_DESTRUCT_CONFIRM':
        return playPage(`${playHeading('你要啟動技能嗎？', '', game.dayAction.actorId)}<div class="self-destruct-summary"><strong>自爆</strong><span>自己出局，本日取消投票</span></div>`, `${btn('確認自爆', 'CONFIRM_SELF_DESTRUCT', 'danger')}${btn('返回發言', 'CANCEL_DAY_ACTION', 'secondary')}`);
      case 'DAY_VOTE_RESULT': return selectionPage('本輪投票結果');
      case 'NEXT_NIGHT':
        return playPage(`${publicNoticeHTML()}${symbol('moon')}<div class="play-phase-label">第 ${game.round} 天結束</div><h1 class="cue-title">準備第 ${game.round + 1} 夜</h1>`, btn('天黑', 'NEXT_NIGHT'), 'center cue-panel');
      case 'GAME_OVER': {
        const good = game.winner.camp === 'good';
        const reason = { wolves_eliminated: '所有狼人已死亡', villagers_eliminated: '所有村民已死亡', gods_eliminated: '所有神職已死亡' }[game.winner.reason];
        return panel(`<span class="eyebrow">本局結束</span>${symbol(good ? 'sun' : 'moon')}<h1 class="title-serif">${good ? '好人陣營' : '狼人陣營'}獲勝</h1><p class="muted">${reason}</p>${endingText(game) ? `<div class="ending-summary">${esc(endingText(game))}</div>` : ''}<div class="victory-stats"><div><strong>${game.round}</strong><span>回合</span></div><div><strong>${game.config.playerCount}</strong><span>位玩家</span></div></div><div class="actions">${btn('查看完整身份', 'SHOW_ROLES')}${btn('查看本局紀錄', 'SHOW_HISTORY', 'secondary')}${btn('再玩一局', 'NEW_GAME', 'soft')}</div>`, 'center');
      }
      case 'GAME_ROLES':
        return panel(`${heading('本局完整身份', '遊戲已結束，所有身份現在公開。', '覆盤 / 身份')}
          <div class="identity-list">${game.players.map(p => `<div class="identity-item"><span class="seat">${String(p.id).padStart(2, '0')}</span>${roleIcon(p.role, 'list-icon')}<div><strong>${ROLES[p.role].name}</strong><small>${p.alive ? '存活' : '已出局'} · ${p.camp === 'wolf' ? '狼人陣營' : '好人陣營'}</small></div></div>`).join('')}</div>
          <div class="actions">${btn('查看本局紀錄', 'SHOW_HISTORY', 'secondary')}${btn('返回結果', 'BACK')}</div>`);
      case 'GAME_HISTORY':
        return panel(`${heading('本局完整紀錄', '包含夜間選擇、用藥與死亡技能。', '覆盤 / 流程')}${historyHTML()}<div class="actions">${btn('返回結果', 'BACK')}</div>`);
      default: return panel(heading('畫面無法讀取', '請重新載入並恢復本局。'));
    }
  }
  function endingText(g) {
    const ids = g.ending?.playerIds || [];
    if (!ids.length) return '';
    const names = ids.map(id => `${id} 號`).join('、');
    if (g.ending.source === 'night') return `昨晚 ${names} 玩家死亡`;
    if (g.ending.source === 'vote') return `${names} 玩家被放逐`;
    if (g.ending.source === 'self_destruct') return `${names} 玩家自爆出局`;
    if (g.ending.source === 'duel') return `決鬥結果：${names} 玩家死亡`;
    return `${names} 玩家死亡`;
  }
  function historyDescription(entry) {
    const target = entry.target;
    switch (entry.type) {
      case 'guard_protect': return entry.target === null ? '守衛本晚不守護。' : `守衛守護 ${entry.target} 號。`;
      case 'knight_duel': return `${entry.source} 號向 ${target} 號決鬥；${entry.victim} 號死亡，無遺言。${entry.success ? '取消本日投票。' : '未終局則繼續白天。'}`;
      case 'self_destruct': return `${entry.source} 號自爆出局；無遺言，本日取消投票。`;
      case 'wolf_attack': return `狼人襲擊 ${target} 號。`;
      case 'seer_pass': return '預言家本晚不查驗。';
      case 'evil_reflect': return `${entry.source} 號惡靈騎士因${entry.trigger === 'witch_poison' ? '女巫下毒' : '預言家查驗'}觸發一次反傷，${target} 號死亡。`;
      case 'evil_immune': return `${target} 號惡靈騎士免疫本晚傷害：${entry.causes.map(c => ({ wolf: '狼刀', witch_poison: '毒藥', guard_heal: '同守同救' }[c] || c)).join('、')}。`;
      case 'seer_check': return `預言家查驗 ${target} 號：${entry.result === 'wolf' ? '狼人' : '好人'}。`;
      case 'witch_heal': return `女巫使用解藥，救 ${target} 號。`;
      case 'witch_poison': return `女巫使用毒藥，毒 ${target} 號。`;
      case 'witch_pass': return '女巫本晚未使用藥品。';
      case 'role_inactive': return `${ROLES[entry.role]?.name || '此角色'}無存活行動者，本晚保留主持流程。`;
      case 'night_result': return entry.deaths.length ? `夜間死亡：${entry.deaths.map(id => `${id} 號`).join('、')}。` : '夜間結果：平安夜。';
      case 'vote_result': return target === null ? '投票結果：沒有人出局。' : `投票結果：${target} 號被放逐。`;
      case 'death_skill': return `${entry.source} 號${ROLES[playerById(game, entry.source).role].name}啟動技能，帶走 ${target} 號。`;
      case 'death_skill_pass': return `${entry.source} 號未啟動死亡技能。`;
      case 'game_over': return `遊戲結束：${entry.winner === 'good' ? '好人陣營' : '狼人陣營'}獲勝。`;
      default: return '';
    }
  }
  function historyHTML() {
    const groups = [];
    for (const entry of game.history) {
      const text = historyDescription(entry);
      if (!text) continue;
      const title = `第 ${entry.round} ${entry.period === 'night' ? '夜' : '天'}`;
      let last = groups[groups.length - 1];
      if (!last || last.title !== title) { last = { title, items: [] }; groups.push(last); }
      last.items.push(text);
    }
    return groups.map(group => `<section class="history-group"><h2>${group.title}</h2>${group.items.map(text => `<div class="history-item">${esc(text)}</div>`).join('')}</section>`).join('');
  }

  function render() {
    let html;
    if (view === 'home') html = renderHome();
    else if (view === 'setup-count') html = renderSetupCount();
    else if (view === 'setup-roles') html = renderSetupRoles();
    else if (view === 'setup-confirm') html = renderSetupConfirm();
    else if (paused || foreignUpdate) html = renderPause();
    else html = renderGame();
    const nightTheme = view === 'game' && (paused || isNight(game) || game.status === 'reveal' || (game.phase === 'GAME_OVER' && game.winner.camp === 'wolf'));
    document.body.dataset.theme = nightTheme ? 'night' : 'day';
    document.getElementById('theme-color').setAttribute('content', nightTheme ? '#101d1c' : '#f4f1e8');
    document.body.dataset.mode = view === 'game' && active && !paused && !foreignUpdate && game.status === 'playing' ? 'play' : 'standard';
    const focusAction = document.activeElement?.dataset?.action;
    const focusId = document.activeElement?.dataset?.id;
    const focusChoice = document.activeElement?.dataset?.choice;
    app.innerHTML = html;
    // 同頁換選擇保留鍵盤焦點，不自動聚焦「提交」造成誤操作。
    if (document.body.dataset.mode === 'play' && ['UI_SELECT', 'UI_ALTERNATIVE', 'UI_WITCH_CHOICE'].includes(focusAction)) {
      const candidate = [...app.querySelectorAll('button[data-action]')].find(b => b.dataset.action === focusAction && b.dataset.id === focusId && b.dataset.choice === focusChoice);
      candidate?.focus({ preventScroll: true });
    }
    // 私密內容不使用 aria-live，以免輔助朗讀器自動念出身份。
    if (view === 'game' && active && !paused && !foreignUpdate && game.status !== 'finished') {
      toolbar.innerHTML = `<button type="button" class="icon-button" data-action="REPLAY" aria-label="重播公開主持詞" title="重播公開主持詞" ${!safeReplayPrompt() ? 'disabled' : ''}>${icons.audio}<span class="toolbar-label">重播</span></button><button type="button" class="icon-button" data-action="PAUSE" aria-label="暫停並遮蔽畫面" title="暫停">${icons.pause}</button>`;
    } else toolbar.innerHTML = '<span class="version-pill">V1.5</span>';
    renderNotice(); renderFooter(); updateVoiceOptions(); updateTimerDOM();
  }

  /* ── 事件：已確認動作只經由 reducer 寫入，不直接修改 DOM 裡的結果 ── */
  function dispatch(action) {
    if (!game || !active || paused || foreignUpdate) return;
    try {
      const next = interfaceTransition(game, action);
      const phaseChanged = next.phase !== game.phase;
      const sameSurface = ['WITCH_HEAL', 'WITCH_POISON'].includes(game.phase) && ['WITCH_HEAL', 'WITCH_POISON'].includes(next.phase);
      if (phaseChanged) {
        clearTimeout(returnTimer); returnTimer = null;
        flowToken += 1; voice.cancel(); autoKey = null;
        stopClock();
        if (!(isSlotPhase(game) && isSlotPhase(next))) clock = null;
      }
      game = next;
      saveGame();
      render();
      if (phaseChanged && !sameSurface) {
        window.scrollTo(0, 0);
        if (game.status !== 'reveal' && !isSlotPhase(game)) app.focus({ preventScroll: true });
      }
      ensureFlow();
      saveGame();
      if (game.status === 'finished') releaseWakeLock();
      else requestWakeLock();
    } catch (error) { toast(error.message || '操作未完成，遊戲資料未改動。'); }
  }
  function beginSetup() {
    const oldConfig = game?.config || savedEnvelope?.game.config;
    clearFlow(); active = false; paused = false; foreignUpdate = false;
    game = null; clock = null; releaseWakeLock();
    draft = oldConfig ? clone(oldConfig) : { playerCount: 8, roles: recommendedRoles(8), nightSeconds: settings.nightSeconds };
    draft.nightSeconds = settings.nightSeconds;
    view = 'setup-count'; render(); window.scrollTo(0, 0);
  }
  function performDeal() {
    try {
      const created = createGame(draft);
      clearFlow(); clock = null; game = created; view = 'game';
      active = true; paused = false; foreignUpdate = false; pauseReason = '';
      saveIssue = ''; lastAnnounced = ''; wakeFailed = false;
      saveGame(); render(); requestWakeLock(); window.scrollTo(0, 0);
    } catch (error) { toast(error.message); }
  }
  function loadGame() {
    const found = readEnvelope();
    if (!found) { savedEnvelope = null; render(); toast('沒有可恢復的遊戲存檔。'); return; }
    clearFlow();
    savedEnvelope = found; game = compactState(found.game);
    const restoredClock = cleanSavedClock(found.clock);
    clock = restoredClock?.kind === 'slot' || isNightBuffer(game, restoredClock) ? restoredClock : null;
    active = true; view = 'game'; foreignUpdate = false;
    pauseReason = 'resume';
    paused = game.status !== 'finished'; autoKey = null; lastAnnounced = '';
    render();
    if (!paused) ensureFlow();
    window.scrollTo(0, 0);
  }
  function abandonGame() {
    clearFlow(); releaseWakeLock();
    active = false; paused = false; foreignUpdate = false; game = null; clock = null;
    savedEnvelope = null; view = 'home';
    try { localStorage.removeItem(STORAGE_KEY); }
    catch (_) { saveIssue = '無法清除本機存檔，請稍後在瀏覽器網站設定中清除。'; }
    render(); window.scrollTo(0, 0);
  }

  const ENGINE_ACTIONS = new Set([
    'AUTO', 'UI_COMMIT', 'UI_ALTERNATIVE',
    'REVEAL', 'REMEMBER', 'START', 'REVIEW', 'BACK', 'CONFIRM_GUARD', 'CONFIRM_WOLF', 'CONFIRM_SEER',
    'ACK_SEER', 'PASS_SEER', 'CONFIRM_PASS_SEER', 'CHOOSE_HEAL', 'CONFIRM_HEAL', 'SKIP_HEAL', 'PASS_POISON',
    'CONFIRM_PASS', 'CONFIRM_POISON', 'ACK_WITCH', 'CONTINUE_RESULT', 'ACK_WORDS',
    'ACTIVATE_SKILL', 'PASS_SKILL', 'CONFIRM_PASS_SKILL', 'CONFIRM_SKILL', 'VOTE',
    'CONFIRM_VOTE', 'CONTINUE_NO_VOTE', 'NEXT_NIGHT', 'SHOW_ROLES', 'SHOW_HISTORY',
    'CANCEL_DAY_ACTION', 'START_DAY_ACTION', 'CONFIRM_DUEL', 'CONFIRM_SELF_DESTRUCT'
  ]);
  let lastClickKey = '';
  let lastClickAt = -1000;
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled || actionBusy) return;
    const action = button.dataset.action;
    const clickKey = `${action}:${button.dataset.id || ''}:${button.dataset.role || ''}:${button.dataset.delta || ''}:${button.dataset.choice || ''}`;
    if (clickKey === lastClickKey && performance.now() - lastClickAt < 220) return;
    lastClickKey = clickKey; lastClickAt = performance.now();
    actionBusy = true;
    try {
      if (ENGINE_ACTIONS.has(action)) { dispatch({ type: action }); return; }
      switch (action) {
        case 'UI_SELECT': case 'SELECT': case 'OPEN_DAY_ACTION': dispatch({ type: action, id: Number(button.dataset.id) }); break;
        case 'UI_WITCH_CHOICE': dispatch({ type: action, choice: button.dataset.choice }); break;
        case 'CUE_CONTINUE': continueTextCue(); break;
        case 'NEW_GAME': beginSetup(); break;
        case 'HOME':
          view = 'home'; savedEnvelope = readEnvelope(); render(); break;
        case 'SETUP_COUNT': view = 'setup-count'; render(); window.scrollTo(0, 0); break;
        case 'SETUP_ROLES': view = 'setup-roles'; render(); window.scrollTo(0, 0); break;
        case 'SETUP_CONFIRM':
          if (configErrors(draft).length) toast(configErrors(draft).join(' '));
          else { view = 'setup-confirm'; render(); window.scrollTo(0, 0); }
          break;
        case 'COUNT': {
          const count = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, draft.playerCount + Number(button.dataset.delta)));
          draft.playerCount = count; draft.roles = recommendedRoles(count); render(); break;
        }
        case 'PRESET_COUNT': {
          const count = Number(button.dataset.id);
          if (integer(count) && count >= MIN_PLAYERS && count <= MAX_PLAYERS) {
            draft.playerCount = count; draft.roles = recommendedRoles(count); render();
          }
          break;
        }
        case 'ROLE_COUNT': {
          const role = button.dataset.role;
          if (['wolf', 'villager'].includes(role)) {
            draft.roles[role] = Math.max(role === 'wolf' ? 0 : 1, Math.min(draft.playerCount, draft.roles[role] + Number(button.dataset.delta))); render();
          }
          break;
        }
        case 'TOGGLE_ROLE': {
          const role = button.dataset.role;
          if (['seer', 'witch', 'hunter', 'guard', 'knight', 'wolfking', 'evilknight'].includes(role)) { draft.roles[role] = draft.roles[role] ? 0 : 1; render(); }
          break;
        }
        case 'RECOMMEND_ROLES': draft.roles = recommendedRoles(draft.playerCount); render(); break;
        case 'DEAL':
          if (savedEnvelope?.game && savedEnvelope.game.status !== 'finished') {
            showDialog('覆蓋上一局？', '重新分配身份後，上一局進度將無法恢復。', performDeal, '覆蓋並分配', true);
          } else performDeal();
          break;
        case 'LOAD_GAME': case 'RELOAD_LATEST': loadGame(); break;
        case 'PAUSE': pauseGame('manual'); break;
        case 'RESUME': resumeGame(); break;
        case 'RESUME_TEXT': resumeGame(true); break;
        case 'ABANDON':
          showDialog('確定放棄這一局？', '這會清除目前遊戲與本局紀錄，不會公開任何身份。', abandonGame, '放棄本局', true); break;
        case 'DIALOG_CANCEL': closeDialog(); break;
        case 'DIALOG_CONFIRM': {
          const callback = dialogCallback; closeDialog(); callback?.(); break;
        }
        case 'TOGGLE_AUDIO':
          settings.audio = !settings.audio; voiceIssue = ''; voice.cancel(); persistSettings(); render(); break;
        case 'TOGGLE_AWAKE':
          settings.keepAwake = !settings.keepAwake;
          if (!settings.keepAwake) releaseWakeLock();
          persistSettings(); render(); break;
        case 'TEST_VOICE':
          voice.speak('語音測試。天黑請閉眼，狼人請睜眼。', true).then(result => {
            if (result.ok) { voiceIssue = ''; renderNotice(); toast('測試播放已完成；請自行確認是否聽見清楚的中文。'); }
            else if (result.reason !== 'cancelled') { notifyVoiceFailure(); toast('語音未完成。請更換中文語音，或改用文字模式。'); }
          });
          break;
        case 'REPLAY':
          if (!settings.audio) { toast('語音已關閉；可在暫停設定中開啟。'); break; }
          if (AUTO_PHASES.has(game.phase)) {
            clearFlow(); clock = null; render(); ensureFlow(); saveGame();
          } else {
            voice.speak(safeReplayPrompt()).then(result => {
              if (!result.ok && result.reason !== 'cancelled') notifyVoiceFailure();
            });
          }
          break;
      }
    } catch (error) { toast(error.message || '操作未完成，請重新確認。'); }
    finally { actionBusy = false; }
  });

  document.addEventListener('change', event => {
    const setting = event.target.dataset.setting;
    if (!setting) return;
    if (setting === 'voiceURI') settings.voiceURI = event.target.value;
    else if (setting === 'rate') {
      const value = Number(event.target.value);
      if ([0.8, 0.92, 1, 1.1].includes(value)) settings.rate = value;
    } else if (setting === 'nightSeconds' && view === 'setup-confirm') {
      const value = Number(event.target.value);
      if ([30, 45, 60, 90].includes(value)) { settings.nightSeconds = value; draft.nightSeconds = value; }
    }
    voiceIssue = ''; persistSettings();
  });

  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && active && game && game.status !== 'finished' && !foreignUpdate) {
      // 先遮蔽再儲存；回到分頁時必須由原操作玩家明確繼續。
      if (!paused) pauseGame('hidden'); else { clearFlow(); saveGame(); }
    }
  });
  window.addEventListener('pagehide', () => {
    if (active && game && !foreignUpdate) {
      if (game.status !== 'finished' && !paused) pauseGame('hidden');
      else { clearFlow(); saveGame(); }
    }
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && active && game && game.status !== 'finished') pauseGame('hidden');
  });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return;
    if (!active || !game || game.status === 'finished') {
      savedEnvelope = readEnvelope(); if (view === 'home') render(); return;
    }
    try {
      const envelope = event.newValue ? JSON.parse(event.newValue) : null;
      if (!envelope || envelope.writerId !== writerId) {
        foreignUpdate = true; pauseGame('conflict', false);
      }
    } catch (_) { foreignUpdate = true; pauseGame('conflict', false); }
  });

  loadSettings();
  savedEnvelope = readEnvelope();
  voice = new Voice();
  if (!voice.supported) { settings.audio = false; voiceIssue = '目前瀏覽器不支援語音主持，已切換為文字模式。'; }
  render();
})();

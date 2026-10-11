import { useState, useEffect } from 'react';
import { usePiStore, type AskQuestion, type AskAnswer } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

/**
 * AskUserPanel：展示在输入框上方，当 agent 调用 ask 工具时出现。
 * 支持多问题分步填写、单选/多选、自由输入（"其他"）。
 * 提交后通过 window.pi.askUserResponse 回传答案给主进程。
 */
export default function AskUserPanel() {
  const { askQuestions, setAskQuestions } = usePiStore();
  const [currentIdx, setCurrentIdx] = useState(0);
  // 每个问题的答案：selectedLabels + customInput
  const [answers, setAnswers] = useState<Record<string, { labels: string[]; custom: string }>>({});
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (askQuestions) {
      setCurrentIdx(0);
      setAnswers({});
      setShowCustom({});
    }
  }, [askQuestions]);

  if (!askQuestions || askQuestions.length === 0) return null;

  const question: AskQuestion = askQuestions[currentIdx];
  const isLast = currentIdx === askQuestions.length - 1;
  const answer = answers[question.id] ?? { labels: [], custom: '' };
  const isCustomShown = showCustom[question.id] ?? false;

  const toggleOption = (label: string) => {
    const cur = answers[question.id] ?? { labels: [], custom: '' };
    if (question.multi) {
      const has = cur.labels.includes(label);
      cur.labels = has ? cur.labels.filter((l) => l !== label) : [...cur.labels, label];
    } else {
      cur.labels = [label];
    }
    setAnswers({ ...answers, [question.id]: { ...cur } });
  };

  const handleNext = () => {
    if (isLast) {
      handleSubmit();
    } else {
      setCurrentIdx(currentIdx + 1);
    }
  };

  const handlePrev = () => {
    if (currentIdx > 0) setCurrentIdx(currentIdx - 1);
  };

  const handleSubmit = () => {
    const results: AskAnswer[] = askQuestions.map((q) => {
      const a = answers[q.id] ?? { labels: [], custom: '' };
      const wasCustom = showCustom[q.id] ?? false;
      return {
        questionId: q.id,
        selectedLabels: wasCustom ? [] : a.labels,
        customInput: wasCustom ? a.custom || undefined : undefined
      };
    });
    window.pi.askUserResponse(results);
    setAskQuestions(null);
  };

  const handleCancel = () => {
    window.pi.askUserResponse(null);
    setAskQuestions(null);
  };

  const toggleCustom = () => {
    setShowCustom({ ...showCustom, [question.id]: !isCustomShown });
    // 切换到自定义时清除选项选择
    if (!isCustomShown) {
      setAnswers({ ...answers, [question.id]: { labels: [], custom: answer.custom } });
    }
  };

  return (
    <div className="mb-2 rounded-xl border border-od-purple/50 bg-od-bg-alt shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-od-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon name="info" className="w-3 text-od-purple" />
          <span className="text-xs font-medium text-od-text-bright">{t.askTitle}</span>
          {askQuestions.length > 1 && (
            <span className="text-xs text-od-text-dim">
              {t.askProgress(currentIdx + 1, askQuestions.length)}
            </span>
          )}
        </div>
        <button
          onClick={handleCancel}
          className="flex h-5 w-5 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-red"
          title={t.askCancel}
        >
          <Icon name="close" size="xs" />
        </button>
      </div>

      {/* Question body */}
      <div className="px-3 py-2">
        {/* Question text */}
        <div className="mb-2 text-sm text-od-text-bright">{question.question}</div>

        {/* Options */}
        <div className="space-y-1">
          {question.options.map((opt, i) => {
            const selected = answer.labels.includes(opt.label);
            const isRecommended = question.recommended === i;
            return (
              <button
                key={i}
                onClick={() => toggleOption(opt.label)}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  selected
                    ? 'bg-od-purple/20 text-od-text-bright'
                    : 'hover:bg-od-bg-hover text-od-text'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center text-xs ${
                    question.multi ? 'rounded' : 'rounded-full'
                  } ${selected ? 'bg-od-purple text-white' : 'border border-od-border-light'}`}
                >
                  {selected && <Icon name="check" size="xs" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-od-text-bright">{opt.label}</span>
                    {isRecommended && (
                      <span className="rounded bg-od-accent/20 px-1 text-xs text-od-accent">
                        {t.askRecommended}
                      </span>
                    )}
                  </div>
                  {opt.description && (
                    <div className="text-xs text-od-text-dim">{opt.description}</div>
                  )}
                </div>
              </button>
            );
          })}

          {/* "其他" 自由输入选项 */}
          <button
            onClick={toggleCustom}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
              isCustomShown ? 'bg-od-purple/20' : 'hover:bg-od-bg-hover'
            }`}
          >
            <span
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center text-xs ${
                question.multi ? 'rounded' : 'rounded-full'
              } ${isCustomShown ? 'bg-od-purple text-white' : 'border border-od-border-light'}`}
            >
              {isCustomShown && <Icon name="check" size="xs" />}
            </span>
            <span className="text-xs text-od-text">{t.askOther}</span>
          </button>

          {/* 自定义输入框 */}
          {isCustomShown && (
            <textarea
              value={answer.custom}
              onChange={(e) =>
                setAnswers({
                  ...answers,
                  [question.id]: { labels: [], custom: e.target.value }
                })
              }
              placeholder={t.askCustomPlaceholder}
              rows={2}
              className="w-full rounded-lg border border-od-border-light bg-od-bg-dark px-2 py-1.5 text-xs text-od-text-bright placeholder:text-od-text-dim focus:border-od-purple/60 focus:outline-none"
              autoFocus
            />
          )}
        </div>
      </div>

      {/* Footer: navigation + submit */}
      <div className="flex items-center justify-between border-t border-od-border px-3 py-2">
        <button
          onClick={handlePrev}
          disabled={currentIdx === 0}
          className="rounded px-2 py-1 text-xs text-od-text-dim transition-colors hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-30"
        >
          上一题
        </button>
        <button
          onClick={handleNext}
          className="rounded bg-od-purple px-3 py-1 text-xs text-white transition-colors hover:bg-od-purple/80"
        >
          {isLast ? t.askSubmit : '下一题'}
        </button>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react'
import { supabase, type Item } from './lib/supabase'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

type ViewMode = 'voting' | 'results'

export default function App() {
  const [items, setItems] = useState<Item[]>([])
  const [userVotes, setUserVotes] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('voting')
  const [submitting, setSubmitting] = useState(false)
  const [sessionCount, setSessionCount] = useState(0)

  useEffect(() => {
    fetchItems()
    fetchSessionCount()
  }, [])

  async function fetchItems() {
    // Fetch items
    const { data: itemsData, error: itemsError } = await supabase
      .from('items')
      .select('*')
      .order('id', { ascending: true })

    if (itemsError) {
      console.error('Error fetching items:', itemsError)
      setLoading(false)
      return
    }

    // Fetch all likes and count them per item
    const { data: likesData, error: likesError } = await supabase
      .from('likes')
      .select('item_id')

    if (likesError) {
      console.error('Error fetching likes:', likesError)
      setLoading(false)
      return
    }

    // Count votes per item
    const voteCounts = new Map<string, number>()
    likesData?.forEach(like => {
      voteCounts.set(like.item_id, (voteCounts.get(like.item_id) || 0) + 1)
    })

    // Merge vote counts with items
    const itemsWithCounts = (itemsData || []).map(item => ({
      ...item,
      likes_count: voteCounts.get(item.id) || 0
    }))

    console.log('Items with vote counts:', itemsWithCounts)
    setItems(itemsWithCounts)
    setLoading(false)
  }

  async function fetchSessionCount() {
    const { data, error } = await supabase
      .from('likes')
      .select('session_id')

    if (error) {
      console.error('Error fetching sessions:', error)
      return
    }

    // Count unique session IDs
    const uniqueSessions = new Set(data?.map(like => like.session_id) || [])
    setSessionCount(uniqueSessions.size)
  }

  function toggleVote(itemId: string) {
    setUserVotes(prev => {
      const newSet = new Set(prev)
      if (newSet.has(itemId)) {
        newSet.delete(itemId)
      } else {
        newSet.add(itemId)
      }
      return newSet
    })
  }

  async function submitVotes() {
    if (userVotes.size === 0) {
      alert('Please select at least one item to vote for!')
      return
    }

    setSubmitting(true)
    const sessionId = crypto.randomUUID()

    // Insert all votes into the database
    const votesToInsert = Array.from(userVotes).map(itemId => ({
      item_id: itemId,
      session_id: sessionId
    }))

    const { error } = await supabase
      .from('likes')
      .insert(votesToInsert)

    if (error) {
      console.error('Error submitting votes:', error)
      alert('Error submitting votes. Please try again.')
      setSubmitting(false)
      return
    }

    // Refresh items to get updated counts
    await fetchItems()
    await fetchSessionCount()
    setSubmitting(false)
    setViewMode('results')
  }

  function resetVoting() {
    setUserVotes(new Set())
    setViewMode('voting')
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-2xl font-semibold font-space-grotesk text-foreground">Loading...</div>
      </div>
    )
  }

  if (viewMode === 'results') {
    // Prepare chart data - keep in original order (1-50)
    const chartData = items.map((item, index) => ({
      number: index + 1,
      name: `${index + 1}`,
      votes: item.likes_count,
      label: item.label
    }))

    // For the ranked list below chart
    const rankedData = [...chartData].sort((a, b) => b.votes - a.votes)

    return (
      <div className="min-h-screen bg-background py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="text-center mb-12">
            <h1 className="text-5xl font-bold text-foreground mb-4 font-space-grotesk">
              Results: 50 Things Sasha Knows
            </h1>
            <p className="text-foreground/80 text-lg max-w-2xl mx-auto leading-relaxed mb-6">
              {sessionCount} {sessionCount === 1 ? 'person has' : 'people have'} voted so far
            </p>
          </div>

          {/* Chart */}
          <div className="bg-card border-2 border-border rounded-xl p-8 mb-8">
            <h2 className="text-2xl font-bold text-foreground mb-6 font-space-grotesk">
              Vote Distribution
            </h2>
            <ResponsiveContainer width="100%" height={500}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#CFCFCF" opacity={0.3} />
                <XAxis
                  dataKey="name"
                  stroke="#182B40"
                  style={{ fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  label={{ value: 'Item Number', position: 'insideBottom', offset: -5 }}
                />
                <YAxis
                  stroke="#182B40"
                  style={{ fontSize: 12, fontFamily: 'JetBrains Mono' }}
                  label={{ value: 'Votes', angle: -90, position: 'insideLeft' }}
                  allowDecimals={false}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload[0]) {
                      const data = payload[0].payload
                      return (
                        <div className="bg-card border-2 border-primary p-4 rounded-lg shadow-lg max-w-md">
                          <p className="font-semibold text-foreground mb-2">Item #{data.number}</p>
                          <p className="text-foreground/80 text-sm mb-2">{data.label}</p>
                          <p className="text-primary font-bold">{data.votes} votes</p>
                        </div>
                      )
                    }
                    return null
                  }}
                />
                <Bar dataKey="votes" fill="#00C4E7" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Detailed List */}
          <div className="bg-card border-2 border-border rounded-xl p-8 mb-8">
            <h2 className="text-2xl font-bold text-foreground mb-6 font-space-grotesk">
              All Items (Ranked by Votes)
            </h2>
            <div className="space-y-3">
              {rankedData.map((item, index) => (
                <div
                  key={item.number}
                  className="flex items-start gap-4 p-4 bg-background/50 rounded-lg"
                >
                  <div className="flex items-center gap-3 min-w-[100px]">
                    <span className="text-foreground/60 font-jetbrains text-sm">#{item.number}</span>
                    <span className="text-primary font-bold font-jetbrains">{item.votes}</span>
                  </div>
                  <p className="text-foreground/80 text-sm flex-1">{item.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Vote Again Button */}
          <div className="text-center">
            <button
              onClick={resetVoting}
              className="bg-primary text-foreground px-8 py-4 rounded-lg font-semibold font-space-grotesk text-lg hover:opacity-90 transition-opacity"
            >
              Vote Again
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Voting mode
  return (
    <div className="min-h-screen bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold text-foreground mb-4 font-space-grotesk">
            50 Things Sasha Knows
          </h1>
          <p className="text-foreground/80 text-lg max-w-2xl mx-auto leading-relaxed mb-6">
            From Sasha Chapin's essay{' '}
            <a
              href="https://sashachapin.substack.com/p/50-things-i-know"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline font-semibold"
            >
              "50 Things I Know"
            </a>
            . Vote for the things you find most resonant.
          </p>
          <p className="text-foreground/60 text-base max-w-2xl mx-auto">
            Click the moon to select items — you can vote for as many as you want!
          </p>
        </div>

        {/* Items List */}
        <div className="space-y-3 mb-8">
          {items.map((item, index) => {
            const hasVoted = userVotes.has(item.id)
            return (
              <div
                key={item.id}
                onClick={() => toggleVote(item.id)}
                className="bg-card border-2 border-border rounded-xl p-6 cursor-pointer transition-all duration-200 hover:border-primary hover:shadow-lg group"
              >
                <div className="flex items-start justify-between gap-6">
                  <div className="flex gap-4 flex-1">
                    <span className="text-foreground/40 font-jetbrains text-sm min-w-[30px]">
                      {index + 1}.
                    </span>
                    <p className="text-card-foreground text-base leading-relaxed">
                      {item.label}
                    </p>
                  </div>
                  <div className="flex flex-col items-center gap-1 min-w-[70px]">
                    <button
                      className="text-4xl transition-all duration-200 group-hover:scale-110"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleVote(item.id)
                      }}
                    >
                      {hasVoted ? '🌕' : '🌑'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Vote Counter and Submit */}
        <div className="sticky bottom-0 bg-background/95 backdrop-blur-sm border-t-2 border-border py-6 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <p className="text-foreground/60 text-sm font-jetbrains">
              You've selected {userVotes.size} item{userVotes.size !== 1 ? 's' : ''}
            </p>
            <button
              onClick={submitVotes}
              disabled={submitting || userVotes.size === 0}
              className="bg-primary text-foreground px-8 py-3 rounded-lg font-semibold font-space-grotesk hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Submitting...' : 'Submit My Votes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
